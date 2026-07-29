# Data Model: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

## Wire-contract change: two schemas, one field each

Both changes live in **`packages/cockpit/src/gates/schema.ts`**.

### `GateOpenSchema` — Shape 1 (cluster → cloud, up-path)

**File**: `packages/cockpit/src/gates/schema.ts:53-70`

**Current shape** (abbreviated):

```ts
export const GateOpenSchema = z.object({
  type: z.literal('gate-open'),
  gateId: z.string().length(24),
  gateKey: z.string().min(1),
  gateType: GateTypeSchema,
  epicRef: z.string().min(1),
  issueRef: z.string().min(1),
  // ... (12 more fields) ...
  askedAt: z.string().datetime(),
});
```

**Post-fix shape** (only the added field shown; all existing fields UNCHANGED):

```ts
export const GateOpenSchema = z.object({
  type: z.literal('gate-open'),
  // ... (all 17 existing fields, unchanged) ...
  askedAt: z.string().datetime(),

  /**
   * #1066 — Correlation frame id (per generacy-cloud#890).
   * Union-with-transform normalizes '' to absent so the outbound frame carries
   * no frameId key when the caller supplied one that would collide on the
   * cloud's `typeof data.frameId === 'string'` guard. Cloud reads the value
   * from `data.frameId` at services/api/src/services/relay/message-handler.ts:804.
   */
  frameId: z
    .union([z.string().min(1), z.literal('').transform(() => undefined)])
    .optional(),
});
```

### `GateOutcomeSchema` — Shape 2, THE ACK (cluster → cloud, up-path)

**File**: `packages/cockpit/src/gates/schema.ts:77-83`

**Current shape**:

```ts
export const GateOutcomeSchema = z.object({
  type: z.literal('gate-outcome'),
  gateId: z.string().length(24),
  outcome: z.enum(['applied', 'superseded', 'failed']),
  detail: z.string().optional(),
  at: z.string().datetime(),
});
```

**Post-fix shape** (only the added field shown; all existing fields UNCHANGED):

```ts
export const GateOutcomeSchema = z.object({
  type: z.literal('gate-outcome'),
  // ... (all 5 existing fields, unchanged) ...
  at: z.string().datetime(),

  /** #1066 — Correlation frame id. Same shape and rationale as GateOpenSchema.frameId. */
  frameId: z
    .union([z.string().min(1), z.literal('').transform(() => undefined)])
    .optional(),
});
```

### Inferred TypeScript types

The inferred types on the exports at `schema.ts:71` and `:84` widen automatically:

```ts
export type GateOpen = z.infer<typeof GateOpenSchema>;
// After fix, `frameId?: string | undefined` appears on the type.

export type GateOutcome = z.infer<typeof GateOutcomeSchema>;
// After fix, `frameId?: string | undefined` appears on the type.
```

**No manual type declaration change is required** — `z.infer<...>` propagates the widening automatically. Consumers get the new property with `?.` access.

### `packages/cockpit/src/gates/index.ts` re-exports

**File**: `packages/cockpit/src/gates/index.ts:5-9` (re-exports `GateOpenSchema`, `GateOutcomeSchema`, `type GateOpen`, `type GateOutcome`).

**Change**: none. The re-exports are name-based, so the widened schemas and types flow through automatically. No edit needed.

## Parse-time invariant

For **both** `GateOpenSchema` and `GateOutcomeSchema`, after `<Schema>.parse(input)` succeeds:

| Input value for `frameId`     | Presence on parsed object    | Value on parsed object |
| ----------------------------- | ---------------------------- | ---------------------- |
| omitted (key not present)     | absent                       | `undefined` (via `.optional()`) |
| explicitly `undefined`        | absent                       | `undefined`            |
| `""` (empty string)           | absent (normalized)          | `undefined` (via `.literal('').transform(() => undefined)`) |
| `"abc123"` (non-empty string) | present                      | `"abc123"` (verbatim)  |
| `null`                        | rejected                     | `ZodError` — union does not accept null |
| `123` (number)                | rejected                     | `ZodError`             |
| `{}` (object)                 | rejected                     | `ZodError`             |
| `[]` (array)                  | rejected                     | `ZodError`             |

The **absent** rows are the load-bearing ones for FR-004: `JSON.stringify` on the parsed object omits keys whose values are `undefined`, so the outbound frame's `data` never carries `frameId` in those cases. The **verbatim** row satisfies FR-003.

## Outbound relay frame shape

**Wire envelope** — unchanged. `packages/cluster-relay/src/messages.ts` `EventMessage` continues to be:

```ts
{
  type: 'event';
  event: 'cluster.cockpit';
  data: unknown;         // the parsed gate-open OR gate-outcome payload
  timestamp: string;     // ISO
}
```

**Data payload** — widened via the schema change above. Post-fix, the `data` field contains a parsed `GateOpen` or `GateOutcome`, which now includes `frameId?: string`. Position: **inside `data`**, alongside `gateId`, `gateType`, and the other payload fields (Q1 → A). **Not** on the envelope.

### Outbound frame examples

**With `frameId` supplied** (FR-003):

```json
{
  "type": "event",
  "event": "cluster.cockpit",
  "data": {
    "type": "gate-open",
    "gateId": "a1b2c3d4e5f6a7b8c9d0e1f2",
    "gateKey": "generacy-ai/generacy#1021:clarification:batch-1",
    "gateType": "clarification",
    "...": "...",
    "askedAt": "2026-07-21T15:04:05.123Z",
    "frameId": "frm_01H8...ABC"
  },
  "timestamp": "2026-07-21T15:04:05.567Z"
}
```

**Without `frameId`** (FR-004 / FR-006 — the older-caller case):

```json
{
  "type": "event",
  "event": "cluster.cockpit",
  "data": {
    "type": "gate-open",
    "gateId": "a1b2c3d4e5f6a7b8c9d0e1f2",
    "gateKey": "generacy-ai/generacy#1021:clarification:batch-1",
    "gateType": "clarification",
    "...": "...",
    "askedAt": "2026-07-21T15:04:05.123Z"
  },
  "timestamp": "2026-07-21T15:04:05.567Z"
}
```

Note the *absence* of the `frameId` key in the second example — not `"frameId": null`, not `"frameId": ""`, absent. This is what makes the cloud's `typeof data.frameId === 'string'` guard fall through to `null` (per cited cloud source), which is the desired behavior for pre-`frameId` callers.

## Retention path — data flow unchanged

**File**: `packages/orchestrator/src/routes/retained-cockpit-events.ts` — **no code change**.

`RetainedEvent` type (`:3-8`):

```ts
export interface RetainedEvent {
  event: 'cluster.cockpit';
  data: unknown;         // opaque — retainer never introspects
  timestamp: string;
  approxBytes: number;
}
```

**Enqueue path** (`cockpit-gates.ts:176-181`): `retainer.enqueue({ event, data: ctx.data, timestamp, approxBytes })`. `ctx.data` is `parsed`, which post-fix includes `frameId` if the caller supplied one.

**Drain path** (`retained-cockpit-events.ts:64-87`): `client.send({ type: 'event', event: 'cluster.cockpit', data: head.data, timestamp: head.timestamp })`. `head.data` is the object held by reference since enqueue — it carries `frameId` through unchanged.

**No new fields, no new types, no code changes on this path.** SC-005's assertion is a regression test locking this behavior against future refactors that might filter or copy `data`.

## Type-level compatibility matrix

| Consumer                                                    | Reads `frameId`? | Writes `frameId`? | Breaks? |
| ----------------------------------------------------------- | ---------------- | ----------------- | ------- |
| `packages/orchestrator/src/routes/cockpit-gates.ts` (POST)  | no (opaque)      | forwards if present via `parsed` | no |
| `packages/orchestrator/src/routes/cockpit-gates.ts` (ACK)   | no (opaque)      | forwards if present via `parsed` | no |
| `packages/orchestrator/src/routes/retained-cockpit-events.ts` | no             | forwards if present via `head.data` reference | no |
| Existing `packages/cockpit/src/__tests__/gates-schemas.test.ts` | no          | no                | no (existing fixtures omit `frameId`) |
| Existing `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` | no | no (fixture omits) | no (outbound-frame equality checks pass; new field absent) |
| Existing `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts` | no | no | no |
| New `cockpit-gates-frameid.integration.test.ts` (SC-001)    | yes              | yes               | n/a (new file) |
| MCP tools / doorbell / ad-hoc clients (external)            | up to caller     | up to caller      | no (field is optional) |
| generacy-cloud `services/api/src/services/relay/message-handler.ts:804` | reads `data.frameId` via `typeof === 'string'` | no | no (already handles absence via ternary → null) |

## Zod version constraint

The union-with-transform pattern requires Zod 3.x, which is workspace-managed and used throughout `packages/cockpit`. The `.transform()` runs on the matched branch of `.union()`, producing `undefined` on the empty-string branch. Combined with `.optional()`, the parsed object has `frameId: undefined` (or `frameId` omitted from the input) in both absent cases; `JSON.stringify` then drops the key at the wire layer.

No `zod` version bump is required.

## Fixture-shape additions (small)

**File**: `packages/cockpit/src/gates/wire-fixtures.ts`

**Change**: extend `GateOpenFixtureOverrides` and `GateOutcomeFixtureOverrides` types with optional `frameId?: string`:

```ts
export interface GateOpenFixtureOverrides {
  // ... existing fields ...
  frameId?: string;
}

export interface GateOutcomeFixtureOverrides {
  // ... existing fields ...
  frameId?: string;
}
```

The `gateOpenFixture` / `gateOutcomeFixture` builder functions spread overrides last (verify at implement time; if they don't, extend the spread order so `overrides.frameId` reaches the output when set). Default builder output remains `frameId`-free.

**File**: `packages/cockpit/src/gates/fixtures.ts` — **no change**. `VALID_FIXTURES` and `VALID_ACK_FIXTURES` stay `frameId`-free by design (spec: absence is the base case).
