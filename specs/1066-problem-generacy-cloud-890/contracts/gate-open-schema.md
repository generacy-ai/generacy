# Contract: `GateOpenSchema` — `frameId` field addition

**File**: `packages/cockpit/src/gates/schema.ts:53-70`
**Type**: additive-optional widening of a public Zod schema

## Field definition

```ts
frameId: z
  .union([z.string().min(1), z.literal('').transform(() => undefined)])
  .optional(),
```

## Position

Appended as the **last field** of the `z.object({ ... })` in `GateOpenSchema`. Placement is cosmetic (Zod object field order does not affect wire behavior), but "last" keeps the diff readable and does not disturb the existing 17-field block.

## Parse-time behavior

| Input `frameId`                     | Parsed output                       |
| ----------------------------------- | ----------------------------------- |
| omitted                             | field absent                        |
| `undefined`                         | field absent                        |
| `""`                                | field absent (normalized transform) |
| `"frm_01H8..."` (non-empty string)  | `frameId: "frm_01H8..."` verbatim   |
| `null`                              | ZodError (union rejects)            |
| `123` (number)                      | ZodError                            |
| `{}` (object)                       | ZodError                            |
| `[]` (array)                        | ZodError                            |
| `true` / `false`                    | ZodError                            |

## Downstream behavior

After `GateOpenSchema.parse(request.body)` in `packages/orchestrator/src/routes/cockpit-gates.ts:318`, the parsed object is forwarded via `tryEmitOrRetain({ data: parsed, ... })`. Two possibilities:

1. **`frameId` present**: the outbound `EventMessage.data.frameId` equals the caller's input byte-for-byte (FR-003).
2. **`frameId` absent** (any of the four absent-input rows above): `JSON.stringify` drops the `undefined` field, so the outbound `EventMessage.data` has no `frameId` key (FR-004). The cloud's `typeof data.frameId === 'string'` guard at `services/api/src/services/relay/message-handler.ts:804` falls through to `null` — the pre-fix behavior, preserved by design for older callers.

## Rejection contract

Non-string, non-omitted, non-empty-string inputs (per the "ZodError" rows above) surface at the route as `400 VALIDATION` via the existing `catch (err) { if (err instanceof ZodError) ... }` block at `cockpit-gates.ts:340-350`. Response body shape unchanged:

```json
{
  "error": "Invalid gate-open payload",
  "code": "VALIDATION",
  "details": [{ "path": ["frameId"], "code": "...", "message": "..." }]
}
```

## Test-matrix contract (SC-003)

The new `describe('frameId', ...)` block in `packages/cockpit/src/__tests__/gates-schemas.test.ts` MUST assert all four cells:

- `parse({ ...VALID_FIXTURES.clarification, frameId: 'abc' })` → succeeds, `parsed.frameId === 'abc'`.
- `parse({ ...VALID_FIXTURES.clarification })` (no `frameId` key) → succeeds, `'frameId' in parsed === false`.
- `parse({ ...VALID_FIXTURES.clarification, frameId: '' })` → succeeds, `'frameId' in parsed === false` (normalized to absent).
- `parse({ ...VALID_FIXTURES.clarification, frameId: 123 })` → throws `ZodError` naming path `['frameId']`.

The absent-key assertion uses `'frameId' in parsed === false`, not `parsed.frameId === undefined`, because the invariant is about key presence on the JSON-serialized outbound frame, not about the JS value being `undefined`. Both are true post-fix, but only the former is what the cloud actually observes.

## Backwards-compatibility contract

Every existing test in `packages/cockpit/src/__tests__/gates-schemas.test.ts` and `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` MUST continue to pass unmodified (SC-004). The fixtures in `VALID_FIXTURES` and `validOpen` at `cockpit-gates.test.ts:34-52` omit `frameId`; the parsed output omits it too; existing `.toEqual(...)` assertions on the outbound frame continue to hold.
