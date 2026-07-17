# Contract: `maybeRefreshAggregate`

Q4=A. Recomputes `phase-complete` / `epic-complete` only when the current
webhook payload could plausibly change an aggregate state. Zero GraphQL cost
on non-completion payloads.

## Signature

```ts
export type AggregateTrigger =
  | { kind: 'completed-label'; label: string }
  | { kind: 'issue-closed' }
  | { kind: 'pr-closed' }
  | null;

export interface AggregateRefreshInput {
  trigger: AggregateTrigger;
  epicRef: string;
  epicRepo: string;
  epicNumber: number;
  prevAgg: AggregateState;
  prev: SnapshotMap;
  currentResolved: ResolvedEpic | null;
  gh: GhWrapper;
  logger: { warn: (msg: string) => void };
  now: () => string;
}

export interface AggregateRefreshOutput {
  events: AggregateEvent[];        // [] when trigger === null
  nextAgg: AggregateState;
  nextPrev: SnapshotMap;
  nextResolved: ResolvedEpic | null;
}

export async function maybeRefreshAggregate(
  input: AggregateRefreshInput,
): Promise<AggregateRefreshOutput>;
```

## Trigger detection

Called by `SmeeDoorbellSource` for every payload. The trigger is derived
before the call:

- `githubEvent === 'issues' && action === 'labeled' && label.name.startsWith('completed:')`
  → `{ kind: 'completed-label', label: label.name }`
- `githubEvent === 'issues' && action === 'closed'`
  → `{ kind: 'issue-closed' }`
- `githubEvent === 'pull_request' && action === 'closed'`
  → `{ kind: 'pr-closed' }`  (both `merged=true` and `merged=false`)
- anything else → `null`

`null` short-circuits the function: it returns `{ events: [], nextAgg:
prevAgg, nextPrev: prev, nextResolved: currentResolved }` with zero I/O.

## On-trigger execution

1. If `currentResolved == null`, run `resolveEpic({ epicRef, gh, logger })`.
   (In practice `currentResolved` is populated by the SSE source at startup;
   this is a safety branch.)
2. Run `runOnePoll(prev, { gh, refs: resolved.parsed.allRefs, epicOwnerRepo:
   resolved.epic.repo, logger })`.
3. Run `computeAggregateEvents({ curr: pollResult.curr, parsed:
   resolved.parsed, epicRepo, epicNumber, prevState: prevAgg, initial:
   false, now })`.

Returns:
```ts
{
  events: aggregateResult.events,
  nextAgg: aggregateResult.nextState,
  nextPrev: pollResult.curr,
  nextResolved: resolved,
}
```

## Debouncing

Debounce is the caller's responsibility, not this function's. The caller
(`SmeeDoorbellSource`) collapses trigger bursts within 500 ms into one call.

## Idempotency

`computeAggregateEvents` guards double-emit via `AggregateState.seenCompletePhases`
and `epicComplete`. Repeated calls with the same input produce the same
output.

## Cost bound

- `null` trigger: 0 gh calls.
- Any trigger: 1 `resolveEpic` (only when `currentResolved == null`) + 1
  `runOnePoll` (fanned out to N refs — same shape as poll-mode cost, and
  already gate-optimized by #970 for check-run re-fetches).

## Failure behavior

- `resolveEpic` fails → log warn; return `{ events: [], nextAgg: prevAgg,
  nextPrev: prev, nextResolved: currentResolved }`. Silent for the operator
  (next completion signal will retry).
- `runOnePoll` fails → same behavior.
- Never throws to the caller.

## Test cases

- `trigger = null` → zero gh calls; identity output.
- `trigger = { kind: 'completed-label', label: 'completed:implement' }`,
  all implement refs closed in snapshot → returns one `phase-complete`
  event; `nextAgg.seenCompletePhases` contains the phase token.
- `trigger = { kind: 'issue-closed' }`, all refs closed → returns one
  `epic-complete` event.
- Consecutive calls with same trigger: idempotent (no double-emit).
- `resolveEpic` throws → identity output; one warn.
