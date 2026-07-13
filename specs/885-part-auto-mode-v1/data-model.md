# Data Model: Aggregate events

## Payload types

```ts
// packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts

export interface PhaseCompleteEvent {
  type: 'phase-complete';
  phase: string;       // ParsedPhase.heading (not token — human-readable, stable)
  epicRepo: string;    // owner/repo of the epic
  epicNumber: number;  // issue number of the epic
  ts: string;          // ISO-8601
  initial?: true;      // set on startup sweep only
}

export interface EpicCompleteEvent {
  type: 'epic-complete';
  epicRepo: string;
  epicNumber: number;
  ts: string;
  initial?: true;
}

export type AggregateEvent = PhaseCompleteEvent | EpicCompleteEvent;
```

## Zod schemas

```ts
import { z } from 'zod';

const RepoRegex = /^[^/]+\/[^/]+$/;

export const PhaseCompleteEventSchema = z.object({
  type: z.literal('phase-complete'),
  phase: z.string().min(1),
  epicRepo: z.string().regex(RepoRegex),
  epicNumber: z.number().int().positive(),
  ts: z.string().datetime(),
  initial: z.literal(true).optional(),
});

export const EpicCompleteEventSchema = z.object({
  type: z.literal('epic-complete'),
  epicRepo: z.string().regex(RepoRegex),
  epicNumber: z.number().int().positive(),
  ts: z.string().datetime(),
  initial: z.literal(true).optional(),
});

export const AggregateEventSchema = z.discriminatedUnion('type', [
  PhaseCompleteEventSchema,
  EpicCompleteEventSchema,
]);

export type AggregateEventValidated = z.infer<typeof AggregateEventSchema>;
```

## Aggregate state (in-process, not on wire)

```ts
// packages/generacy/src/cli/commands/cockpit/watch/aggregate.ts

export interface AggregateState {
  /** phase.token values previously observed as fully-complete. Membership means
   *  "we already emitted phase-complete for this phase in the current watch run." */
  seenCompletePhases: Set<string>;
  /** True once we've emitted epic-complete. Blocks re-emission after regressions. */
  epicComplete: boolean;
}

export function initialAggregateState(): AggregateState {
  return { seenCompletePhases: new Set(), epicComplete: false };
}
```

Regression semantics: when a phase transitions from complete → incomplete (reopen), its `token` is **removed** from `seenCompletePhases`. Same for `epicComplete: false` when any ref reopens. This is what makes "reopen → regress → re-complete fires twice" work (spec test).

## Pure aggregate computation

```ts
export interface AggregateComputeInput {
  curr: SnapshotMap;             // current poll's snapshot map
  parsed: ParsedEpicBody;        // resolved epic body (phases + allRefs)
  epicRepo: string;              // resolved from watch's --epic argument
  epicNumber: number;
  prevState: AggregateState;
  initial: boolean;              // true on first poll only (prev SnapshotMap was empty)
  now: () => string;             // ISO-8601 timestamp source
}

export interface AggregateComputeResult {
  events: AggregateEvent[];      // ordered: phase-complete in body order, then epic-complete
  nextState: AggregateState;
}

export function computeAggregateEvents(
  input: AggregateComputeInput,
): AggregateComputeResult;
```

## Validation rules

| Field | Rule |
|-------|------|
| `type` | Enum `'phase-complete' \| 'epic-complete'` (discriminator) |
| `phase` (phase-complete only) | Non-empty string; matches `ParsedPhase.heading` exactly (not `.token`) |
| `epicRepo` | Matches `^[^/]+/[^/]+$` |
| `epicNumber` | Positive integer |
| `ts` | ISO-8601 with time zone (`z.string().datetime()`) |
| `initial` | Literal `true` when present; absent otherwise (never `false`) |

## Relationships

- `AggregateEvent.epicRepo` + `.epicNumber` correlate with `ResolvedEpic.epic: IssueRef` (`packages/cockpit/src/resolver/types.ts`).
- `PhaseCompleteEvent.phase` correlates with `ParsedPhase.heading` — same string, byte-for-byte.
- Emission order is defined externally (by `watch.ts`), not by the payload itself. Consumers relying on order should trust the stream sequence, not any field.
- Aggregate events are **disjoint** from `CockpitEvent` (per-issue). They share the same NDJSON stdout stream but have no overlapping field names beyond `ts` and `initial`. Consumers must dispatch on `type` (aggregate) vs. `event` (per-issue) — no key collides.

## Completeness predicates

```ts
// A phase is complete when every ref in it has a CLOSED snapshot in curr.
// Empty phase (refs.length === 0) is NOT considered "complete" for emission
// purposes — it's silently trivially complete for epic-complete only.
function isPhaseComplete(phase: ParsedPhase, curr: SnapshotMap): boolean {
  if (phase.refs.length === 0) return false; // emission gate; see epic-complete for aggregation
  return phase.refs.every((ref) => {
    const snap =
      curr.get(snapshotKey(ref.repo, 'issue', ref.number)) ??
      curr.get(snapshotKey(ref.repo, 'pr', ref.number));
    return snap != null && snap.state === 'CLOSED';
  });
}

// Epic is complete when every ref in allRefs has a CLOSED snapshot.
// Empty phases contribute nothing to allRefs, so they don't block this check.
function isEpicComplete(parsed: ParsedEpicBody, curr: SnapshotMap): boolean {
  if (parsed.allRefs.length === 0) return false; // no-refs epic is never complete
  return parsed.allRefs.every((ref) => {
    const snap =
      curr.get(snapshotKey(ref.repo, 'issue', ref.number)) ??
      curr.get(snapshotKey(ref.repo, 'pr', ref.number));
    return snap != null && snap.state === 'CLOSED';
  });
}
```
