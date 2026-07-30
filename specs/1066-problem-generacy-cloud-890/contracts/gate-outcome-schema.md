# Contract: `GateOutcomeSchema` — `frameId` field addition

**File**: `packages/cockpit/src/gates/schema.ts:77-83`
**Type**: additive-optional widening of a public Zod schema

## Field definition

```ts
frameId: z
  .union([z.string().min(1), z.literal('').transform(() => undefined)])
  .optional(),
```

**Identical shape to `GateOpenSchema.frameId`** — same rationale, same parse-time behavior, same downstream contract. This contract file exists as the second half of the pair per FR-002; every clause below is a mechanical port of the `GateOpenSchema` contract.

## Position

Appended as the **last field** of the `z.object({ ... })` in `GateOutcomeSchema` (after `at`).

## Parse-time behavior

Identical matrix to `gate-open-schema.md § Parse-time behavior`. `GateOutcomeSchema.parse({ ...validAckCandidate, frameId: '<value>' })` follows the same absent/present/verbatim/reject rows.

## Route-level composition

The `POST /cockpit/gates/:id/ack` handler at `packages/orchestrator/src/routes/cockpit-gates.ts:360-433` builds the candidate object via:

```ts
const candidate = {
  ...(body ?? {}),                    // includes caller-supplied `frameId` if present
  type: 'gate-outcome' as const,
  gateId: pathGateId,                  // path is authoritative for gateId
  at: /* body.at || Date.now().toISO */,
};
const parsed = GateOutcomeSchema.parse(candidate);
```

The `...(body ?? {})` spread on the first line naturally carries `frameId` from `request.body` into `candidate`; the newly-widened schema retains it through `.parse()`; the existing forward pattern (`tryEmitOrRetain({ data: parsed, ... })` at `:400-409`) emits it on the outbound `EventMessage.data`.

**No code change required** at the route. The candidate-building spread was written before this feature and happens to compose correctly with it — the field flows through as a natural consequence of `...(body ?? {})`.

## Rejection contract

Same shape as `GateOpenSchema`; response body from the route's existing `ZodError` catch at `:419-429`:

```json
{
  "error": "Invalid gate-outcome payload",
  "code": "VALIDATION",
  "details": [{ "path": ["frameId"], "code": "...", "message": "..." }]
}
```

## Test-matrix contract (SC-003, gate-outcome half)

The `describe('frameId', ...)` block in `packages/cockpit/src/__tests__/gates-schemas.test.ts` MUST also assert the four cells against `GateOutcomeSchema` using a valid ack fixture (e.g., `VALID_ACK_FIXTURES.applied`):

- `parse({ ...VALID_ACK_FIXTURES.applied, frameId: 'abc' })` → succeeds, `parsed.frameId === 'abc'`.
- `parse({ ...VALID_ACK_FIXTURES.applied })` → succeeds, `'frameId' in parsed === false`.
- `parse({ ...VALID_ACK_FIXTURES.applied, frameId: '' })` → succeeds, `'frameId' in parsed === false`.
- `parse({ ...VALID_ACK_FIXTURES.applied, frameId: 123 })` → throws `ZodError` naming path `['frameId']`.

## Backwards-compatibility contract

Every existing test in `packages/cockpit/src/__tests__/gates-schemas.test.ts` and `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` targeting `GateOutcomeSchema` or `POST /cockpit/gates/:id/ack` MUST continue to pass unmodified. The `validAckBody` fixture at `cockpit-gates.test.ts:60-64` omits `frameId`; the parsed output omits it; existing assertions hold.
