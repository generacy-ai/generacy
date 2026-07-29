# Data Model: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**Branch**: `1067-problem-generacy-1053-s`

Diff-only. Only entities changed by this PR are listed. Everything else is
unchanged from the pre-#1067 baseline documented in `specs/1038-issue-1038/data-model.md`.

---

## E1: `CockpitGateStatusInput` (MCP boundary)

**File**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:20-29`

**Before** (pre-#1067):

```ts
export const CockpitGateStatusInputSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema,
    generation: z.union([z.string().min(1), z.number()]),
  })
  .strict();
```

**After**:

```ts
export const CockpitGateStatusInputSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema,
    generation: z.union([z.string().min(1), z.number()]),
    /**
     * #1067 — Optional per-run discriminator. When supplied, forwarded to the
     * cloud as the 4th `gateKey` segment so a re-run under a new `runId` sees
     * a fresh gate. Omitted → cloud derives with pre-#1053 3-tuple shape.
     */
    runId: z.string().min(1).optional(),
  })
  .strict();
```

**Validation rules**:
- `runId` MUST be a non-empty string when present.
- Schema remains `.strict()` — MCP callers passing extra fields still get `invalid-args`.
- Schema remains a flat `z.object` (SC-006).

**Wire contract**: the tool handler passes `runId` verbatim to the query client; the query client forwards as a `runId=<value>` query-string parameter on the outbound URL to the orchestrator. The orchestrator then forwards to the cloud gate-query client, which appends the same `runId=<value>` on the URL to the cloud.

---

## E2: `CockpitGateListInput` (MCP boundary)

**File**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:53-59`

**Before** (pre-#1067):

```ts
export const CockpitGateListInputSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
  })
  .strict();
```

**After**:

```ts
export const CockpitGateListInputSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    /**
     * #1067 — Accepted on the MCP surface for parity with `cockpit_gate_status`.
     * DELIBERATELY DROPPED by the tool handler before calling the cloud
     * client (see tools/cockpit_gate_list.ts). The deployed cloud contract
     * (generacy-cloud#892) carries `.refine((q) => q.runId === undefined ||
     * q.generation !== undefined, { message: 'runId requires generation' })`
     * and list mode has no `generation` by construction, so forwarding
     * `runId` on list produces a 400 RFC-7807 and breaks the sweep's
     * primary dedup primitive.
     */
    runId: z.string().min(1).optional(),
  })
  .strict();
```

**Validation rules**: same as E1.

**Behavioural contract**: `runId` is **accepted but never propagated**. This is deliberate; per clarification Q1=C and Q3=C, `cockpit_gate_list` MUST NOT forward `runId` to the query client OR emit the `runIdSource` log line.

---

## E3: `GetGateStatusInput` (cluster→cloud client)

**File**: `packages/orchestrator/src/services/cloud-gate-query-client.ts:62-66`

**Before** (pre-#1067):

```ts
export interface GetGateStatusInput {
  issueRef: string;
  gateType: GateType;
  generation: string;
}
```

**After**:

```ts
export interface GetGateStatusInput {
  issueRef: string;
  gateType: GateType;
  generation: string;
  /**
   * #1067 — Optional per-run discriminator. Forwarded to the cloud as a
   * `runId=<value>` query-string parameter on `GET /api/clusters/:id/cockpit/gates`.
   * The cloud route accepts this only when `generation` is also present
   * (`.refine((q) => q.runId === undefined || q.generation !== undefined)`).
   * When omitted, the outbound URL is byte-identical to the pre-#1067 shape.
   */
  runId?: string;
}
```

**Validation rules**:
- Type-level only; the cluster→cloud client trusts its cluster-side caller (the orchestrator route) to have validated the shape.
- `undefined` produces zero difference in the outbound URL — the existing `buildUrl` loop skips undefined values.

**Note**: `ListGatesInput` is **NOT** widened (Q1=C). The route MUST NOT call `listGates` with a `runId` field.

---

## E4: `GateQueryStringSchema` (orchestrator route)

**File**: `packages/orchestrator/src/routes/cockpit-gates.ts:57-66`

**Before** (pre-#1067):

```ts
const GateQueryStringSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    generation: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.generation === undefined || v.gateType !== undefined, {
    message: 'gateType is required when generation is present',
  });
```

**After**:

```ts
const GateQueryStringSchema = z
  .object({
    issueRef: z.string().min(1),
    gateType: GateTypeSchema.optional(),
    generation: z.string().min(1).optional(),
    /**
     * #1067 — Passive pass-through. Route MUST NOT enforce
     * "runId ⇒ generation" here — the cloud route enforces it authoritatively
     * (`services/api/src/routes/clusters/cockpit-gates.ts` .refine). Duplicating
     * the refinement would mask the cloud's RFC-7807 400 behind a route-side
     * 'VALIDATION' 400.
     */
    runId: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.generation === undefined || v.gateType !== undefined, {
    message: 'gateType is required when generation is present',
  });
```

**Validation rules**:
- `runId` is a passive pass-through at this boundary.
- Forwarded ONLY on the status branch (`generation !== undefined`).
- MUST NOT be forwarded on the list branch (`generation === undefined`).

---

## E5: `cockpit_gate_status.runid-source` log record

**Source** (new): `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_status.ts`

**Emission points**: post-call, on BOTH success and failure branches.

**Field shape**:

```ts
{
  event: 'cockpit_gate_status.runid-source',
  runIdSource: 'explicit' | 'unset',
  mode: 'status',
  gateType: string,           // from parsed.data.gateType
  issueRef: string,           // from parsed.data.issueRef
  resolvedStatus: 'open' | 'answered' | 'absent' | 'error',
  gateId: string | null,      // returned from cloud (null on 'absent' or error)
  error?: string,             // present iff resolvedStatus === 'error'
}
```

**Invariants**:
- The `runId` **value** is NEVER logged (only the `runIdSource` label). Enforced by test in `cockpit-gate-status-runid.test.ts`.
- `cockpit_gate_list` MUST NOT emit this record (Q3=C consequent of Q1=C).
- The success message text is not asserted — only the field shape.

**Rationale**: mirrors `cockpit_gate_open.runid-source` (`cockpit_gate_open.ts:88-97`) but with post-call placement to observe the actual resolved status. Data-model E-3 (from #1053) rule "`runId` value is never logged" is preserved verbatim.

---

## Relationships

```
CockpitGateStatusInput (E1)  ─→  GateQueryStringSchema (E4)  ─→  GetGateStatusInput (E3)  ─→  cloud (Phase A)
                                                                                                    │
                                                                                                    ↓
                                                          cloud stores/keys by (issueRef, gateType, generation, runId?)

CockpitGateListInput (E2)    ─→  GateQueryStringSchema (E4)  ─→  ListGatesInput (unchanged)  ─→  cloud (Phase A)
        └── runId accepted but dropped at MCP tool handler ─┘
```

**Byte-compat guarantee**: with `runId === undefined` on E1, every entity in the chain omits the field entirely — the outbound URL is byte-identical to the pre-#1067 shape (FR-005 / SC-001).

---

*Generated by /speckit:plan on 2026-07-29.*
