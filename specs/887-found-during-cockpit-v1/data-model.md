# Data Model: Uniform `type` discriminator on `cockpit watch` NDJSON stream

## Overview

Three event types share the `cockpit watch` NDJSON stream. After this change, every event carries a `type` field with one of exactly three literal values. All three types compose into a single Zod discriminated union.

## Entities

### `IssueTransitionEvent` (extended from existing `CockpitEvent`)

Per-issue state transition emitted by the poll loop's diff step.

**TypeScript** (`packages/generacy/src/cli/commands/cockpit/watch/diff.ts`):

```ts
export interface CockpitEvent {
  type: 'issue-transition';            // NEW — required
  ts: string;                          // ISO-8601 UTC datetime
  repo: string;                        // "owner/repo"
  kind: 'issue' | 'pr';
  number: number;                      // positive integer
  from: CockpitState | null;           // null on initial sweep
  to: CockpitState | null;             // null on terminal close
  sourceLabel: string | null;          // matched label that determined `to`
  url: string;                         // issue or PR URL
  event: 'label-change' | 'issue-closed' | 'pr-merged' | 'pr-closed' | 'pr-checks';
  labels: string[];                    // full label set at snapshot time
  initial?: true;                      // startup-sweep marker (#839)
}
```

**Zod** (`packages/generacy/src/cli/commands/cockpit/watch/emit.ts`):

```ts
export const CockpitEventSchema = z.object({
  type: z.literal('issue-transition'),  // NEW
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
  initial: z.literal(true).optional(),
});
```

**Validation rules**:
- `type` MUST equal the literal `'issue-transition'` (Zod enforced).
- `ts` MUST parse as ISO-8601 datetime.
- `repo` MUST match `owner/repo` shape (regex).
- `number` MUST be positive integer.
- `initial` is optional; when present MUST equal literal `true` (never `false`).
- All other field values, formats, and enums are unchanged from the pre-887 shape.

### `PhaseCompleteEvent` (unchanged)

Emitted once per transition into a fully-closed phase.

**TypeScript** (`packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts`):

```ts
export interface PhaseCompleteEvent {
  type: 'phase-complete';
  phase: string;                       // non-empty
  epicRepo: string;                    // "owner/repo"
  epicNumber: number;                  // positive integer
  ts: string;                          // ISO-8601 UTC datetime
  initial?: true;                      // startup-sweep marker (#885)
}
```

**Zod** (unchanged from `aggregate-emit.ts`):

```ts
export const PhaseCompleteEventSchema = z.object({
  type: z.literal('phase-complete'),
  phase: z.string().min(1),
  epicRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  epicNumber: z.number().int().positive(),
  ts: z.string().datetime(),
  initial: z.literal(true).optional(),
}).strict();
```

### `EpicCompleteEvent` (unchanged)

Emitted once when every ref in the epic is CLOSED.

**TypeScript** (`packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts`):

```ts
export interface EpicCompleteEvent {
  type: 'epic-complete';
  epicRepo: string;
  epicNumber: number;
  ts: string;
  initial?: true;
}
```

**Zod** (unchanged from `aggregate-emit.ts`):

```ts
export const EpicCompleteEventSchema = z.object({
  type: z.literal('epic-complete'),
  epicRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  epicNumber: z.number().int().positive(),
  ts: z.string().datetime(),
  initial: z.literal(true).optional(),
}).strict();
```

### `CockpitStreamEvent` (NEW — the union)

The full type of every line the watcher emits.

**TypeScript + Zod** (`packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`, NEW):

```ts
import { z } from 'zod';
import { CockpitEventSchema } from './emit.js';
import { PhaseCompleteEventSchema, EpicCompleteEventSchema } from './aggregate-emit.js';

export const CockpitStreamEventSchema = z.discriminatedUnion('type', [
  CockpitEventSchema,
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
]);

export type CockpitStreamEvent = z.infer<typeof CockpitStreamEventSchema>;
```

**Public API** (re-exported from `packages/generacy/src/index.ts`):

```ts
export {
  CockpitStreamEventSchema,
} from './cli/commands/cockpit/watch/stream-event.js';
export type { CockpitStreamEvent } from './cli/commands/cockpit/watch/stream-event.js';
```

## Invariants

1. **Every line has `type`**: any output on stdout from `emit()` or `emitAggregate()` is a JSON object with a string `type` field equal to one of `'issue-transition'`, `'phase-complete'`, `'epic-complete'`. Enforced by the stamping step inside both emit functions (FR-004), which runs before the `skipValidate` branch.
2. **Discriminator closed at three values**: `CockpitStreamEventSchema._def.options` has exactly three entries. Any new event type requires a spec update (see Assumptions in spec).
3. **Back-compat on `event` field**: `event` remains present, unchanged in value set and semantics, on every `issue-transition` line.
4. **Purely additive**: no field on any variant is renamed, retyped, or removed.

## Relationships

- `CockpitStreamEventSchema` is the discriminated union over the other three schemas — the only public schema external consumers should import.
- `CockpitEventSchema` (per-issue) and `AggregateEventSchema` (phase + epic) remain exported for backward compatibility with existing internal callers (`watch.ts`, tests). The union is *composed from* their constituents; they do not disappear.
- `CockpitEvent` interface in `diff.ts` is the internal construction type; its runtime shape is validated by `CockpitEventSchema` in `emit.ts` before hitting stdout.
