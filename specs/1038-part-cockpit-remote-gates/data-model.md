# Data Model: gate-status query + stable generation derivation

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**Companion**: [plan.md](./plan.md), [research.md](./research.md)

All schemas below are authored in Zod. TypeScript types are `z.infer<>` of their schema unless called out. Field-level notes carry the rationale for any non-obvious constraint.

---

## §1. `GateStatus` — the three-state response contract

```typescript
// packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts (additions)

/** Closed three-state query response (spec Q2→C; INV-3). */
export const GateStatusSchema = z.enum(['open', 'answered', 'absent']);
export type GateStatus = z.infer<typeof GateStatusSchema>;
```

**Mapping from cloud enum** (documented at the derivation site, not enforced by schema — the cloud responder does the projection):

| Cloud status | GateStatus |
|---|---|
| `open` | `open` |
| `answered`, `delivered`, `applied` | `answered` |
| `superseded`, `failed`, `expired` | `absent` (dead — sweep may re-draft) |
| *no matching row* | `absent` |

**Validation**: Zod enum; any other string on the wire is a hard MCP boundary failure (`class: 'internal'`) — not silently coerced.

---

## §2. `cockpit_gate_status` — single-gate lookup

### Input schema

```typescript
// mcp/gates/schemas.ts
export const GateStatusInputSchema = z
  .object({
    /** owner/repo#N — must match the exact form used at gate-open time. */
    issueRef: z.string().min(1),
    gateType: GateTypeSchema,
    /**
     * gateType-specific discriminator. Required in single-gate lookup because
     * (issueRef, gateType, generation) fully determines the natural gate.
     * String OR number — coerced identically to gate-open's discriminator.
     */
    generation: z.union([z.string().min(1), z.number()]),
  })
  .strict();
export type GateStatusInput = z.infer<typeof GateStatusInputSchema>;
```

### Response schema

```typescript
// mcp/gates/schemas.ts
export const GateStatusResponseSchema = z.object({
  gateId: z.string().length(24),
  status: GateStatusSchema,
});
export type GateStatusResponse = z.infer<typeof GateStatusResponseSchema>;
```

### Rules

- `gateId` in the response is the **cluster-derived** id (via `deriveGateKey` + `deriveGateId`), NOT one the cloud stamped independently. The tool computes it locally, then passes it into the query. Round-trip equality is INV-1 (SC-002); the response returning a mismatched `gateId` is a hard `internal` error.
- Input is `.strict()` — typos on the MCP boundary become `class: 'invalid-args'`, not silent accepts.
- On sustained transport failure, the tool NEVER returns a `GateStatusResponse` — it returns `class: 'query-unreachable'` (INV-2).

---

## §3. `cockpit_gate_list` — per-issue non-terminal list

### Input schema

```typescript
// mcp/gates/schemas.ts
export const GateListInputSchema = z
  .object({
    /** owner/repo#N — same form as gate-open. */
    issueRef: z.string().min(1),
    /**
     * Optional narrowing filter — v1 filters client-side, but exposing it in
     * the input keeps the shape stable if the cloud responder later grows a
     * server-side gateType predicate (payload-size optimization). Un-set means
     * "all gate types for this issue."
     */
    gateType: GateTypeSchema.optional(),
  })
  .strict();
export type GateListInput = z.infer<typeof GateListInputSchema>;
```

### Response schema

```typescript
// mcp/gates/schemas.ts

/** One row from cockpit_gate_list. Terminal statuses are excluded server-side. */
export const GateListItemSchema = z.object({
  gateId: z.string().length(24),
  gateType: GateTypeSchema,
  /** Non-terminal statuses map to 'open' or 'answered' per §1's table. */
  status: z.enum(['open', 'answered']),
});
export type GateListItem = z.infer<typeof GateListItemSchema>;

export const GateListResponseSchema = z.object({
  gates: z.array(GateListItemSchema),
});
export type GateListResponse = z.infer<typeof GateListResponseSchema>;
```

### Rules

- `gates` is empty `[]` when no non-terminal gates exist — NOT an error, NOT a throw (US3 acceptance).
- Scope is **project-wide** (INV-4, Q5→A): any gate opened by any cluster in the project. The cloud responder is authoritative for scoping.
- Absent (`absent`) status is NOT surfaced in the list — an "absent" gate is not a gate; it's the absence of one. The single-lookup tool (§2) surfaces `absent`; the list tool omits it.
- On sustained transport failure, the tool returns `class: 'query-unreachable'` — NOT an empty list (INV-2, prevents fail-open regression).

---

## §4. `ClarificationGenerationInput` — canonical hash inputs (BREAKING)

**Before** (`packages/cockpit/src/gates/generation.ts:6-11`):

```typescript
export interface ClarificationGenerationInput {
  batchId: string;
}
export function deriveClarificationGeneration(input: ClarificationGenerationInput): string {
  return input.batchId;
}
```

**After**:

```typescript
import { createHash } from 'node:crypto';

/**
 * Canonical inputs for the clarification-gate `generation` discriminator.
 *
 * Each entry is a single question in the current UNANSWERED batch on the issue.
 * Drafted answers are deliberately excluded so multiple sweeps against the same
 * open batch produce identical generations (SC-002 / FR-007 / Q1→A).
 *
 * Uniqueness invariant: `questionNumber` values within the array MUST be
 * distinct. The helper does NOT enforce this — the caller (live path in the
 * MCP tool; sweep path in agency) is responsible for constructing the array
 * from a single well-formed batch. Duplicate numbers would produce a valid but
 * meaningless hash, not a runtime error.
 */
export interface ClarificationBatchQuestion {
  questionNumber: number;
  questionText: string;
}

export interface ClarificationGenerationInput {
  questions: ClarificationBatchQuestion[];
}

/**
 * Derive the `generation` discriminator for a clarification gate.
 *
 * Canonicalization contract (frozen — sweep + live paths MUST hash identical
 * bytes):
 *   1. Sort `questions` ascending by `questionNumber`.
 *   2. Re-emit each entry with a FIXED key order: `questionNumber` then
 *      `questionText` (never `questionText` first, never any extra keys).
 *   3. JSON.stringify the sorted array with no pretty-print, no trailing
 *      whitespace, no key-sorting library (the fixed-order map above IS the
 *      canonical form).
 *   4. sha256 of the resulting bytes, hex-encoded, TRUNCATED to first 24
 *      characters — matches the gateId truncation window so hash prefixes
 *      are comparable at a glance in logs.
 *
 * The 24-char slice is a discriminator (never the identity itself); the full
 * gateId is downstream of `deriveGateKey` → `deriveGateId`.
 */
export function deriveClarificationGeneration(input: ClarificationGenerationInput): string {
  const canonical = [...input.questions]
    .sort((a, b) => a.questionNumber - b.questionNumber)
    .map((q) => ({ questionNumber: q.questionNumber, questionText: q.questionText }));
  return createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex')
    .slice(0, 24);
}
```

### Validation rules

- `questionNumber`: integer ≥ 1 (positional index within the batch; matches how clarifications are numbered in `clarifications.md`). Non-integer or ≤ 0 = caller bug; unchecked at helper (silent hash, still deterministic).
- `questionText`: verbatim string; leading/trailing whitespace is preserved because the sweep parses off GitHub verbatim and the live path passes what the LLM produced verbatim — trimming would drift.
- `questions[]`: empty array is legal (`generation = sha256("[]").slice(0,24)` — same generation for two independent empty batches, which is meaningless but not error-inducing).

### Sample hash (regression anchor)

```typescript
deriveClarificationGeneration({
  questions: [
    { questionNumber: 2, questionText: 'What is the retry budget?' },
    { questionNumber: 1, questionText: 'Which transport should we use?' },
  ],
});
// Canonical bytes (after sort + fixed-key map):
//   '[{"questionNumber":1,"questionText":"Which transport should we use?"},
//     {"questionNumber":2,"questionText":"What is the retry budget?"}]'
// (no whitespace inserted; shown here with line break for readability)
// The parity fixture in gates-generation.test.ts commits the exact sha256[:24].
```

### Migration for callers

- Live path (this repo): `cockpit_gate_open` builds the array from the LLM-drafted `options[]` OR from the parent auto-loop's question ledger (implementation-phase decision).
- Sweep path (agency): parses the `<!-- generacy-stage:clarification -->` batch comment on the issue, extracts `{questionNumber, questionText}` per entry, calls the helper. The agency-side PR is the paired change to `packages/claude-plugin-cockpit/commands/auto.md`.

---

## §5. Relay envelope pair — `gate_query_request` / `gate_query_response`

### `GateQueryRequestMessage` (cluster → cloud)

```typescript
// packages/cluster-relay/src/messages.ts (additions)

export interface GateQueryRequestMessage {
  type: 'gate_query_request';
  /** Correlation id — echoed back on the response. UUID or short random. */
  correlationId: string;
  /** owner/repo#N — issue whose gates we're asking about. */
  issueRef: string;
  /**
   * Query mode:
   *   - 'single': lookup for a specific (gateType, generation) → single row or absent.
   *   - 'list':   all non-terminal gates for the issue.
   */
  mode: 'single' | 'list';
  gateType?: GateType;
  /** Only used in mode:'single'. String OR number (matches gate-open shape). */
  generation?: string | number;
  /** Optional narrowing filter for mode:'list' — v1 filters client-side. */
  gateTypeFilter?: GateType;
}
```

**Zod**:

```typescript
const GateQueryRequestMessageSchema = z.object({
  type: z.literal('gate_query_request'),
  correlationId: z.string().min(1),
  issueRef: z.string().min(1),
  mode: z.enum(['single', 'list']),
  gateType: GateTypeSchema.optional(),
  generation: z.union([z.string().min(1), z.number()]).optional(),
  gateTypeFilter: GateTypeSchema.optional(),
});
```

**Cross-field validation** (enforced at construction site, not by Zod — Zod refinement optional):

- `mode: 'single'` REQUIRES `gateType` AND `generation`.
- `mode: 'list'` MUST NOT set `generation` (ignored if present).

### `GateQueryResponseMessage` (cloud → cluster)

```typescript
export interface GateQueryResponseMessage {
  type: 'gate_query_response';
  correlationId: string;
  /** 'ok' = payload valid; 'error' = payload.error is a human-readable reason. */
  status: 'ok' | 'error';
  /** Present when status === 'ok'; matches the requesting mode. */
  payload?:
    | { mode: 'single'; gateId: string; status: GateStatus }
    | { mode: 'list'; gates: Array<{ gateId: string; gateType: GateType; status: 'open' | 'answered' }> };
  /** Present when status === 'error'. */
  error?: string;
}
```

**Zod**:

```typescript
const GateQueryResponseSinglePayloadSchema = z.object({
  mode: z.literal('single'),
  gateId: z.string().length(24),
  status: GateStatusSchema,
});
const GateQueryResponseListPayloadSchema = z.object({
  mode: z.literal('list'),
  gates: z.array(
    z.object({
      gateId: z.string().length(24),
      gateType: GateTypeSchema,
      status: z.enum(['open', 'answered']),
    }),
  ),
});
const GateQueryResponseMessageSchema = z.object({
  type: z.literal('gate_query_response'),
  correlationId: z.string().min(1),
  status: z.enum(['ok', 'error']),
  payload: z
    .union([GateQueryResponseSinglePayloadSchema, GateQueryResponseListPayloadSchema])
    .optional(),
  error: z.string().optional(),
});
```

### Rules

- Cloud responder MUST echo the requesting `correlationId` verbatim. Orchestrator uses this to route the response to the correct pending promise (multiplex-safe).
- `status: 'error'` payloads MUST supply `error` — orchestrator maps this to HTTP 5xx on the GET route (which the query client's retry loop treats as retryable transport failure).
- Envelope union addition: `RelayMessage`, `RelayMessageSchema` in `packages/cluster-relay/src/messages.ts` gain both variants.

### Correlation-id map (orchestrator side)

Not persisted — module-level `Map<correlationId, { resolve, reject, timer }>` inside `GateStatusQueryService`. Cleared on `resolve` / `reject` / process shutdown. Orphaned entries (never resolved) are a bug that the per-attempt timer catches.

---

## §6. Options-bag extensions

The two new tools reuse the existing `GateClientOptions` (`packages/generacy/src/cli/commands/cockpit/mcp/gates/options.ts`) unchanged — `baseUrl`, `timeoutMs`, `fetchImpl` cover the GET-shaped client identically to the POST-shaped one. No new environment variables. No new deps constructor fields on `BuildMcpServerDeps`.

**Retry-cadence constants** (query-client only):

```typescript
// packages/generacy/src/cli/commands/cockpit/mcp/gates/query-client.ts
const RETRY_BACKOFFS_MS = [500, 1500, 3000] as const;  // 3 attempts, ~5s total
const RETRY_JITTER_FRACTION = 0.1;                     // ±10% per attempt
```

Not exposed via options — the cadence is a spec-side constant (FR-011). Test-only override via internal export if a future test demands a fast-forward.

---

## §7. Error taxonomy

`ErrorClass` gains one member (`packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`):

```typescript
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'scope-not-found'
  | 'query-unreachable'  // NEW — sustained cloud-query outage after bounded retry (FR-011)
  | 'internal';
```

### Where each class fires in the query path

| Situation | Class | Where |
|---|---|---|
| Missing `issueRef` on the MCP call | `invalid-args` | Zod boundary in either tool |
| Missing `gateType`/`generation` when `cockpit_gate_status` needs them | `invalid-args` | Zod boundary + `.strict()` |
| Cloud returns `status: 'error'` in the response envelope | `transport` (per-attempt; retryable) | `query-client.ts` |
| All retry attempts exhausted without a `status: 'ok'` response | `query-unreachable` (terminal) | `query-client.ts` — the ONLY caller-visible way to signal "I do not know" |
| Response payload fails Zod validation | `internal` | Either tool (post-client) |
| Cloud responder is a version that doesn't understand the envelope (e.g. cloud sibling not deployed) | `transport` per-attempt → `query-unreachable` terminal | Falls through the same retry loop; observed as a persistent no-response |

---

## §8. Non-goals for the data model

- **Persistence**: no cluster-side caching of query results. If a scope has 20 issues and the sweep runs three times, the query runs 60 times. This is intentional: the query is cheap by design, and caching introduces stale-read hazards on `applied → superseded` transitions.
- **Pagination**: `cockpit_gate_list` is unpaginated in v1. Long-lived issues with hundreds of non-terminal gates are pathological; if they appear in practice, add a cursor field additively.
- **Field-level auth**: the query has no per-caller auth beyond the existing relay's cluster-API-key channel. Cross-project scoping is the cloud responder's responsibility, not this shape's.
- **Streaming responses**: single response per request; no chunking. The orchestrator's request/response promise is fully materialized before returning.
