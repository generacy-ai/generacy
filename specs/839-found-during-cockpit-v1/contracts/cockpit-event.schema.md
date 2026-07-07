# Contract — `CockpitEventSchema` (v2 — post-#839)

**Location**: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`
**Change**: Additive — one optional field.
**Downstream consumers today**: `/cockpit:watch` plugin markdown (single consumer). No cloud/UI reader exists.

## Schema — machine-readable (Zod)

```ts
import { z } from 'zod';
import { COCKPIT_STATES } from '@generacy-ai/cockpit';

export const CockpitEventSchema = z.object({
  ts: z.string().datetime(),
  repo: z.string().regex(/^[^/]+\/[^/]+$/),
  kind: z.enum(['issue', 'pr']),
  number: z.number().int().positive(),
  from: z.union([z.enum(COCKPIT_STATES), z.null()]),
  to: z.union([z.enum(COCKPIT_STATES), z.null()]),
  sourceLabel: z.string().nullable(),
  url: z.string().url(),
  event: z.enum(['label-change', 'issue-closed', 'pr-merged', 'pr-closed', 'pr-checks']),
  labels: z.array(z.string()),
  initial: z.literal(true).optional(),   // ADDED — Q3 / FR-003 / FR-004
});
```

## Schema — human-readable

| Field | Type | Nullable | Optional | Semantics |
|-------|------|----------|----------|-----------|
| `ts` | ISO 8601 datetime string | no | no | Event emission timestamp |
| `repo` | `owner/repo` string | no | no | GitHub repo |
| `kind` | `'issue' \| 'pr'` | no | no | GitHub entity kind |
| `number` | positive integer | no | no | GitHub issue/PR number |
| `from` | `CockpitState \| null` | yes | no | Prior classified state; `null` on first-poll sweep and on lifecycle events |
| `to` | `CockpitState \| null` | yes | no | Current classified state |
| `sourceLabel` | `string \| null` | yes | no | Classifier-derived label that determined `to` |
| `url` | URL string | no | no | GitHub URL to the issue/PR |
| `event` | discriminator enum | no | no | One of the 5 event kinds |
| `labels` | `string[]` | no | no | Full current label set on the entity |
| `initial` | `true` (literal) | n/a | **yes** | Present ONLY on first-poll sweep lines. ABSENT on polls 2..N. NEVER emitted as `false`. |

## Wire Invariants

### I1 — `initial` presence-encodes first-poll status

- **First poll (`prev.size === 0`)**: for every emitted line, `initial === true`.
- **Polls 2..N**: for every emitted line, the `initial` field is not present in the JSON.
- **Rejected shape**: `{ ..., "initial": false }` — `CockpitEventSchema.parse` throws.

### I2 — First-poll sweep uses `event: 'label-change'`, `from: null`

- Every first-poll line MUST have `event === 'label-change'` and `from === null`.
- No new discriminator (would force plugin fallback — FR-007).

### I3 — `to`/`sourceLabel` on first-poll lines mirror the classifier

- `to === curr.classified.state`
- `sourceLabel === curr.classified.sourceLabel`

The sweep's *decision* uses raw labels (FR-011), but the emitted `to`/`sourceLabel` remain classifier-derived so consumer rendering is unchanged.

### I4 — First-poll sweep only fires when `curr` contains ≥1 actionable snapshot

- If no snapshot in `curr` is actionable, `computeTransitions` returns `[]` (same as today's behavior for a non-actionable baseline).
- SC-002 / US3.

### I5 — First-poll sweep MUST NOT dedupe across runs

- Watcher restart with the same still-pending actionable state MUST re-emit `initial: true` lines.
- FR-008 / US2.

## Compatibility Matrix

| Consumer behavior | Impact |
|-------------------|--------|
| Consumer ignores `initial` field | No behavior change. First-poll sweep lines render as normal `label-change` events with `from: null`. |
| Consumer branches on `event.initial` (truthiness) | Correct — sees `true` on first-poll lines, `undefined` (falsy) on later lines. |
| Consumer branches on `event.initial === false` | Bug in the consumer — will never match. Recommended: switch to truthiness check. |
| Consumer validates via `CockpitEventSchema.parse` | Correct — schema accepts both shapes. |
| Producer emits `initial: false` (e.g., stale test fixture) | Rejected — `emit()` throws at `.parse()` unless `skipValidate: true` is set. Desired defense. |
| Producer omits `initial` on first-poll sweep line | Bug in producer — passes schema but violates I1. Not machine-enforceable; test coverage guards against regressions (SC-005). |

## Test Contracts

The following assertions MUST hold in the regression suite (SC-005):

```ts
// Accept
CockpitEventSchema.parse({ ...baseEvent, initial: true });       // OK
CockpitEventSchema.parse(baseEvent);                              // OK — initial absent

// Reject
expect(() => CockpitEventSchema.parse({ ...baseEvent, initial: false })).toThrow();
expect(() => CockpitEventSchema.parse({ ...baseEvent, initial: 'yes' })).toThrow();
expect(() => CockpitEventSchema.parse({ ...baseEvent, initial: 1 })).toThrow();
```

## Non-Contracts (out of scope for this schema)

- `checksRollup` field on the wire — Q5 / FR-002 uses `checksRollup` to *decide* emission for PRs, but the wire shape does not surface the value. Consumers detect red PRs via label inspection (`failed:*`) or the historical `pr-checks` transition path.
- Cross-run persistence hints (e.g., `previousRunTimestamp`) — sensor stays stateless per FR-008.
- `initial` reason field (e.g., `initialReason: 'label' | 'checks-failure'`) — not surfaced. Consumers key on `labels[]` + `checksRollup` transitions post-first-poll if they need to disambiguate.
