# Data Model: Cockpit gates — Read-Only Query + Stable Generation

Feature: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
Branch: `1038-issue-1038`

This document defines the TypeScript types, Zod schemas, and validation rules
crossing the two new query-tool boundaries (`cockpit_gate_status`,
`cockpit_gate_list`), the orchestrator route that backs them
(`GET /cockpit/gates`), the cluster→cloud query client, and the new
generation-derivation helper for `clarification` gates.

The **wire contracts for the gate records themselves** (`GateOpenSchema`,
`GateOutcomeSchema`, `GateAnswerSchema`, `deriveGateKey`, `deriveGateId`) are
already frozen and owned by sibling #1020 (`@generacy-ai/cockpit`) — this feature
adds **only the query response envelopes** and **one new `generation`
canonicalization helper**.

---

## Overview of entities

```text
┌──────────────────────────┐   POST GET /cockpit/gates?...   ┌───────────────────┐   HTTPS   ┌──────────┐
│ cockpit_gate_status      │  ────────────────────────────▶  │ Orchestrator      │  ─────▶   │ Cloud    │
│ cockpit_gate_list        │                                 │   route           │           │ Firestore│
│  (MCP tool handlers)     │  ◀───── { gateId, status } ───  │  + query client   │  ◀───     │  (source)│
└──────────────────────────┘                                 └───────────────────┘           └──────────┘
        │
        ├─ inputs: CockpitGateStatusInput / CockpitGateListInput
        ├─ outputs: CockpitGateStatusData / CockpitGateListData
        ├─ errors: 'query-unreachable' (NEW), 'invalid-args', 'internal'
        └─ retry: 3 attempts, 0/1500/3500ms (retry.ts)

┌──────────────────────────────┐    ┌─────────────────────────────────┐
│ computeClarificationAnswerSet│    │ deriveClarificationGeneration   │
│   Hash({ questions })        │───▶│   ({ batchId })  (unchanged)    │
│  (NEW, pure)                 │    └─────────────────────────────────┘
└──────────────────────────────┘                    │
                                                    ▼
                                          gateKey / gateId
```

---

## Core types

### Gate status vocabulary

Three MCP-facing statuses (per Q2 → C):

```ts
export type GateStatusThreeState = 'open' | 'answered' | 'absent';
```

Mapping from the cloud-side seven-status vocabulary (applied by the orchestrator
route — see `contracts/gate-query.md`):

| Cloud status | MCP-facing status |
|--------------|-------------------|
| `open`       | `open`            |
| `answered`   | `answered`        |
| `delivered`  | `answered`        |
| `applied`    | `answered`        |
| `superseded` | `absent`          |
| `failed`     | `absent`          |
| `expired`    | `absent`          |
| (no match)   | `absent`          |

---

### `CockpitGateStatusInput`

MCP tool input for `cockpit_gate_status`.

```ts
export const CockpitGateStatusInputSchema = z
  .object({
    /** owner/repo#N — the gate's issue reference. */
    issueRef: z.string().min(1),
    gateType: GateTypeSchema,      // 8-value enum from @generacy-ai/cockpit
    /** gateType-specific discriminator (e.g. the batchId hash, head SHA, ...). */
    generation: z.union([z.string().min(1), z.number()]),
  })
  .strict();
export type CockpitGateStatusInput = z.infer<typeof CockpitGateStatusInputSchema>;
```

**Validation rules**:
- `issueRef` non-empty. Format enforced by the orchestrator (upstream `IssueRef` grammar), not here — MCP boundary just fast-fails empty strings.
- `gateType` from the closed 8-value enum (same as `cockpit_gate_open`).
- `generation` string or number; the tool coerces to string before forwarding, exactly like `deriveGateKey` does.
- `.strict()` catches caller typos (e.g. `issue_ref`, `gate_type`) with `invalid-args`.

### `CockpitGateStatusData`

MCP tool output (inside `ToolOkResult<T>`):

```ts
export interface CockpitGateStatusData {
  /** null when status === 'absent'; otherwise the resolved gateId. */
  gateId: string | null;
  status: GateStatusThreeState;
}
```

Corresponding Zod schema (for `.parse()` in the tool boundary):

```ts
export const CockpitGateStatusDataSchema = z.union([
  z.object({ gateId: z.string().length(24), status: z.enum(['open', 'answered']) }),
  z.object({ gateId: z.null(), status: z.literal('absent') }),
]);
```

**Validation rule**: an `absent` result MUST NOT carry a gateId (nullability is a load-bearing signal to callers).

### `CockpitGateListInput`

```ts
export const CockpitGateListInputSchema = z
  .object({
    issueRef: z.string().min(1),
    /** Optional — narrow to a single gateType. Absent = all types. */
    gateType: GateTypeSchema.optional(),
  })
  .strict();
export type CockpitGateListInput = z.infer<typeof CockpitGateListInputSchema>;
```

### `CockpitGateListData`

```ts
export interface CockpitGateListEntry {
  gateId: string;                    // always present (list excludes 'absent')
  gateType: GateType;
  generation: string;                // always emitted as string (numeric batchIds coerced)
  status: 'open' | 'answered';       // 'answered' collapses cloud delivered/applied
}

export interface CockpitGateListData {
  gates: readonly CockpitGateListEntry[];
  /** Set to true only if the cloud upstream paginates and we did not fetch more.
   *  Absent (not false) when the list is complete. */
  truncated?: boolean;
}
```

Zod:

```ts
export const CockpitGateListEntrySchema = z.object({
  gateId: z.string().length(24),
  gateType: GateTypeSchema,
  generation: z.string().min(1),
  status: z.enum(['open', 'answered']),
});
export const CockpitGateListDataSchema = z.object({
  gates: z.array(CockpitGateListEntrySchema),
  truncated: z.boolean().optional(),
});
```

**Validation rules**:
- The list contains only non-terminal (`open | answered`) entries per Q5 → A. If a `delivered` cloud gate appears, it MUST be collapsed to `answered` by the orchestrator route.
- `generation` is always emitted as a string in the response. Callers wanting a numeric may parse; the wire is JSON, so string is safer.

---

### `ErrorClass` extension

`packages/generacy/src/cli/commands/cockpit/mcp/errors.ts` gains one new member:

```ts
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'query-unreachable'    // NEW — distinct from 'transport' per FR-014 / Q3 → D
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'scope-not-found'
  | 'internal';
```

**Semantics**: `query-unreachable` means the read-side path to the cloud gate store failed after the bounded retry budget (~5s, 3 attempts). Callers MUST NOT treat this as `absent` (spec FR-014); they should abort or surface an operator-visible error.

---

### `ClarificationQuestion` + `computeClarificationAnswerSetHash`

New pure helper in `packages/cockpit/src/gates/clarification-hash.ts` (per Q1 → A):

```ts
export interface ClarificationQuestion {
  questionNumber: number;
  questionText: string;
}

export interface ComputeClarificationAnswerSetHashInput {
  questions: readonly ClarificationQuestion[];
}

/**
 * Canonical answer-set hash for a clarification-gate `generation`.
 *
 * Input: unordered list of `{ questionNumber, questionText }` for every
 * question in the current unanswered batch. Extra fields are stripped by the
 * projection below; ordering is enforced by sort-by-questionNumber ascending.
 *
 * Output: first 12 hex chars of `sha256(<canonical-json>)`.
 *
 * Same round of asks → same generation → same gateId (SC-002).
 */
export function computeClarificationAnswerSetHash(
  input: ComputeClarificationAnswerSetHashInput,
): string {
  const sorted = [...input.questions].sort((a, b) => a.questionNumber - b.questionNumber);
  const canonical = JSON.stringify(
    sorted.map((q) => ({
      questionNumber: q.questionNumber,
      questionText: q.questionText,
    })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
```

**Validation rules (helper-internal)**:
- **Sort order**: strictly ascending `questionNumber`. Ties (duplicate question numbers) are a caller error but the sort is stable so behavior is deterministic if callers pass duplicates.
- **Projection**: only `questionNumber` and `questionText` end up in the canonical JSON — a richer `Question` type with `answerText`, `askedAt`, etc. contributes nothing to the hash. This is the mechanical enforcement of Q1 → A's "question identity only; drafted/pending answers excluded".
- **Serialization**: straight `JSON.stringify` on an array-of-two-key-objects. Deterministic without external canonical-JSON libraries.
- **Length**: 12 hex = 48 bits. Collision-safe for the population (~2⁻²⁴ birthday at 4k open gates project-wide).

**Consumers** (both must go through this helper for SC-002 to hold):

1. **Agency sweep** (out-of-repo, tracked in generacy-ai/agency#450) — reads the current unanswered batch from `clarifications.md` or the API, projects to `ClarificationQuestion[]`, calls the helper, then passes the resulting hash as `batchId` to `deriveClarificationGeneration`.
2. **This repo's live path** — anywhere in `packages/generacy` or `packages/orchestrator` that opens a `clarification` gate. Same call sequence.

**Non-consumer**: `deriveClarificationGeneration({ batchId })` itself is **unchanged**. It continues to accept any opaque `batchId` string — the hash helper is one such source. This preserves backward compatibility with existing tests + fixtures that pass a literal `batchId: 'batch-abc123'` (see `packages/cockpit/src/gates/fixtures.ts:46`).

---

## Orchestrator route: `GET /cockpit/gates`

New handler in `packages/orchestrator/src/routes/cockpit-gates.ts`.

**Query string**:

```text
GET /cockpit/gates
  ?issueRef=<owner/repo#N>              (required)
  &gateType=<one of the 8>              (optional; omit = all types)
  &generation=<discriminator>           (optional; presence = status query,
                                                    absence = list query)
```

**Dispatch rule**:
- `generation` present → single-gate status query. Response: `{ status: GateStatusThreeState, gateId: string | null }`.
- `generation` absent → list query. Response: `{ gates: CockpitGateListEntry[], truncated?: boolean }`.

**Handler logic** (in Fastify pseudo-shape):

```ts
server.get<{ Querystring: GateQueryStringSchema }>(
  '/cockpit/gates',
  async (request, reply) => {
    const parsed = GateQueryStringSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid-query', ... });

    const { issueRef, gateType, generation } = parsed.data;
    const client = options.getCloudGateQueryClient();

    try {
      if (generation !== undefined) {
        // Single-gate status
        const cloudResult = await client.getGateStatus({ issueRef, gateType!, generation });
        return reply.status(200).send(mapCloudStatusToThreeState(cloudResult));
      } else {
        // Non-terminal list, project-wide
        const cloudResult = await client.listGates({ issueRef, gateType });
        return reply.status(200).send(mapCloudListToNonTerminal(cloudResult));
      }
    } catch (err) {
      if (isCloudTransportError(err)) return reply.status(502).send({ error: 'cloud-unreachable', ... });
      return reply.status(500).send({ error: 'internal', ... });
    }
  },
);
```

**Response envelopes** (both 200):

Status:

```json
{ "gateId": "<24-hex>", "status": "open" }
{ "gateId": "<24-hex>", "status": "answered" }
{ "gateId": null,        "status": "absent" }
```

List:

```json
{ "gates": [
  { "gateId": "...", "gateType": "clarification", "generation": "abc123def456", "status": "open" },
  { "gateId": "...", "gateType": "implementation-review", "generation": "sha1234", "status": "answered" }
] }
```

**Non-2xx**:
- `400` — query-string validation failed (missing `issueRef`, `gateType` required if `generation` present, etc.).
- `502` — cloud upstream unreachable (network error, DNS, 5xx from cloud).
- `500` — internal (bug in the route).

The MCP tool handles retry against `502` responses (per R2 / R5); the orchestrator does not retry on the cloud side within a single request.

---

## Cluster → cloud query client

New file `packages/orchestrator/src/services/cloud-gate-query-client.ts`. Mirrors
`packages/control-plane/src/services/cloud-pull-client.ts` in shape:

```ts
export interface CloudGateQueryClient {
  getGateStatus(input: { issueRef: string; gateType: GateType; generation: string })
    : Promise<{ status: string; gateId: string | null }>;
  listGates(input: { issueRef: string; gateType?: GateType })
    : Promise<{ gates: Array<{ gateId: string; gateType: GateType; generation: string; status: string }>;
                truncated?: boolean; }>;
}

export interface CreateCloudGateQueryClientOptions {
  clusterId: string;                     // from cluster.json
  apiUrlEnv?: string;                    // default 'GENERACY_API_URL', test override
  apiKeyPath?: string;                   // default '/var/lib/generacy/cluster-api-key'
  timeoutMs?: number;                    // default 5000
  httpsRequestImpl?: typeof httpsRequest; // test seam
}
```

**Auth**: reads the cluster API key at `/var/lib/generacy/cluster-api-key` (mtime-cached read, same pattern as `cluster-api-key.ts`), sends `Authorization: Bearer <key>`.

**Endpoint**:
`GET ${GENERACY_API_URL}/api/clusters/${clusterId}/cockpit/gates?issueRef=...&gateType=...&generation=...`

**Error handling**: throws `CloudTransportError` on network/DNS/timeout/5xx (caught by the route handler and mapped to HTTP 502). 4xx from cloud is propagated as `CloudRequestError` and mapped to HTTP 500 (indicates a cluster-side bug in the request shape).

**No retry inside the client** — retry lives in the MCP tool per R2. The client is single-call.

---

## Query-string schema (orchestrator side)

```ts
export const GateQueryStringSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    generation: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (v) => v.generation === undefined || v.gateType !== undefined,
    { message: 'gateType is required when generation is present' },
  );
```

**Validation rule**: presence of `generation` implies presence of `gateType` (a status query needs both parts of the `(gateType, generation)` discriminator). Absence of `generation` allows `gateType` to be omitted (list-all-types on this issueRef).

---

## Retry helper (MCP-side)

New file `packages/generacy/src/cli/commands/cockpit/mcp/gates/retry.ts`:

```ts
export interface RetrySchedule {
  /** Delay before each attempt in ms. First entry is typically 0. */
  delays: readonly number[];
}

export const QUERY_RETRY_SCHEDULE: RetrySchedule = Object.freeze({
  delays: Object.freeze([0, 1500, 3500]),  // 3 attempts, total ≤5s
});

export interface WithRetryOptions<T> {
  fn: () => Promise<T>;
  schedule: RetrySchedule;
  shouldRetry: (err: unknown, attempt: number) => boolean;
  sleep?: (ms: number) => Promise<void>;   // test seam
}

export async function withRetry<T>(opts: WithRetryOptions<T>): Promise<T> { ... }
```

**Validation rules**:
- `schedule.delays.length >= 1`. First delay is honored (typically 0 for the initial attempt).
- `shouldRetry` distinguishes retryable (network / 5xx) from terminal (4xx / 200-with-bad-body). Returning `false` stops the loop immediately regardless of remaining attempts.
- Total wall-clock budget = `sum(delays)`. For the constant `QUERY_RETRY_SCHEDULE` this is 5000ms exactly.

**Consumers**: `tools/cockpit_gate_status.ts` and `tools/cockpit_gate_list.ts`. Both call `withRetry({ fn: () => queryClient.get(...), schedule: QUERY_RETRY_SCHEDULE, shouldRetry: isRetryableGateQueryError })`.

---

## Fixtures (test seams)

New fixture entries in `packages/cockpit/src/gates/fixtures.ts` (extend
`GENERATION_FIXTURES`):

```ts
export const CLARIFICATION_ANSWER_SET_FIXTURES = Object.freeze({
  singleQuestion: { questions: [{ questionNumber: 1, questionText: 'Which auth?' }] },
  threeQuestions: {
    questions: [
      { questionNumber: 3, questionText: 'Timezone?' },
      { questionNumber: 1, questionText: 'Which auth?' },        // out of order
      { questionNumber: 2, questionText: 'Which DB?' },
    ],
  },
  // ...
});
```

**Purpose**: prove SC-002 via parity assertions — the sweep constructs its
`questions[]` from GitHub state, the live path from the same GitHub state, and
both must produce byte-identical hashes.

---

## Relationships

- `computeClarificationAnswerSetHash` returns a string that becomes the
  `batchId` input to `deriveClarificationGeneration`.
- `deriveClarificationGeneration({ batchId })` returns a string that becomes
  the `generation` input to `deriveGateKey(issueRef, 'clarification', generation)`.
- `deriveGateKey` returns a string that becomes the input to `deriveGateId`.
- `deriveGateId` returns the 24-hex `gateId` that flows through both the write
  path (`cockpit_gate_open`) and the query path (`cockpit_gate_status`) — the
  match between these two `gateId`s is SC-002's success criterion.

For `implementation-review`, `artifact-review`, `manual-validation`,
`escalation`, `phase-queue`, `filing`, and `scope-drained`: the existing
helpers in `packages/cockpit/src/gates/generation.ts` are unchanged. See
`contracts/generation-derivation.md` for the canonical inputs per gate type.
