# Contract: `GateAnswerEvent` — new `CockpitStreamEvent` variant

**Feature**: #1023 | **Files**:
- `packages/generacy/src/cli/commands/cockpit/watch/gate-answer.ts` (new — schema)
- `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts` (modified — union extension)

## Purpose

Add a fourth discriminated-union member to `CockpitStreamEventSchema` so that operator gate answers flow through the same stdout NDJSON stream and per-epic `EpicEventBus` that carry `issue-transition`, `phase-complete`, and `epic-complete` events today.

## Zod Schema

```ts
// packages/generacy/src/cli/commands/cockpit/watch/gate-answer.ts

import { z } from 'zod';

// FROZEN down-path Shape 3 (flat). No `scope` / nested `answer` / `generation`.
export const GateAnswerActorSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email().nullable(),
  displayName: z.string().nullable(),
});

export const GateAnswerLineSchema = z.object({
  type: z.literal('gate-answer'),
  gateId: z.string().min(1),
  gateKey: z.string().min(1),
  optionId: z.string().nullable(),
  freeText: z.string().nullable(),
  actor: GateAnswerActorSchema,
  answeredAt: z.string().datetime(),
  deliveryId: z.string().min(1),
}).passthrough();

export type GateAnswerLine = z.infer<typeof GateAnswerLineSchema>;

export const GateAnswerEventSchema = z.object({
  type: z.literal('gate-answer'),
  ts: z.string().datetime(),
  gateId: z.string().min(1),
  deliveryId: z.string().min(1),
  epic: z.string().regex(/^[^/]+\/[^/]+#\d+$/),
  line: GateAnswerLineSchema,
});

export type GateAnswerEvent = z.infer<typeof GateAnswerEventSchema>;
```

## Union Extension

```ts
// packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts

import { z } from 'zod';
import { CockpitEventSchema } from './emit.js';
import { PhaseCompleteEventSchema, EpicCompleteEventSchema } from './aggregate-emit.js';
import { GateAnswerEventSchema } from './gate-answer.js';   // NEW

export const CockpitStreamEventSchema = z.discriminatedUnion('type', [
  CockpitEventSchema,
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
  GateAnswerEventSchema,                                     // NEW
]);

export type CockpitStreamEvent = z.infer<typeof CockpitStreamEventSchema>;
```

## Consumer Impact

| Consumer | File | Impact |
|---|---|---|
| `EpicEventBus.emit(event)` | `mcp/event-bus.ts:144` | None. Signature already accepts `CockpitStreamEvent`. |
| `subscribeAndEmit` / `lineForEvent` | `doorbell/subscribe.ts:22` | None. `lineForEvent` calls `JSON.stringify(event)`. |
| `cockpit_await_events` | `mcp/tools/cockpit_await_events.ts` | None. Returns `CockpitStreamEvent[]`; new variant flows through opaquely. |
| `exitOnEpicComplete` branch in `runPollMode` | `doorbell.ts:187` | None. Existing `event.type === 'epic-complete'` check narrows correctly against the extended union. |
| Any TypeScript caller pattern-matching on `type` | project-wide | Must add a `case 'gate-answer'` if using exhaustive-check helpers. Non-exhaustive callers unaffected. |

## Invariants

1. **`type` discriminator uniqueness**: `'gate-answer'` does not collide with existing literals (`'issue-transition'`, `'phase-complete'`, `'epic-complete'`).
2. **Field-name uniqueness**: no overlap with sibling variants beyond the shared `type` + `ts` fields.
3. **Round-trip stability**: `CockpitStreamEventSchema.parse(JSON.parse(lineForEvent(event)))` returns an equivalent `GateAnswerEvent` (Zod defaults / coercions do not mutate the payload). Verified by contract test.
4. **`.passthrough()` on `line`**: unknown fields in the wire NDJSON survive parse → emit → JSON.stringify → parse round-trip. Enables the sibling P4 dispatch step to see fields added upstream without a schema bump in this repo.

## Contract Tests (locations)

- `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.unit.test.ts` — schema round-trip + happy-path emit.
- Existing `packages/generacy/src/cli/commands/cockpit/__tests__/index.test.ts` — extend to enumerate the union arm count if a coverage assertion already exists.
