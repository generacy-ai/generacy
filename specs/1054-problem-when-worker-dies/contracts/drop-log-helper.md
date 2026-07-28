# Contract — `drop-log-helper.ts`

Pure-function shared decision for FR-006 (adapter-side) + FR-007 (monitor-side) severity escalation. One point of decision → SC-004 (severity divergence = 0) provable by construction.

## Exports

```ts
export interface DropTransitionState {
  lastSeverity: 'info' | 'warn';
}

export interface DropSeverityDecision {
  severity: 'info' | 'warn';
  /** True when this call flipped severity vs. the previous state for this itemKey. */
  isTransitionEdge: boolean;
  stateAfter: DropTransitionState;
}

/**
 * Decide whether this drop-log call should escalate to `warn`.
 *
 * Transition-edge semantics (per clarifications Q4=A + FR-006 addition):
 *   - Emits `warn` **once** when the entry's age first crosses `thresholdMs`.
 *   - Emits `warn` **once** when the entry clears (drops back below threshold).
 *   - Between transitions the line stays at `info` regardless of how many
 *     monitor cycles fire (this is what makes the signal actually visible in
 *     log queries — 17 identical `warn`s is the anti-pattern that hid #1054).
 *
 * @param itemKey  The in-flight itemKey (`<owner>/<repo>#<issue>`).
 * @param ageMs    Age of the in-flight entry in ms. `null` on transport error
 *                 → fall back to `info` (fail-safe).
 * @param thresholdMs  DispatchConfig.maxRunDurationMs (default 30 min).
 * @param state    Caller-owned Map keyed by itemKey. Read + written by this fn.
 */
export function classifyDropSeverity(
  itemKey: string,
  ageMs: number | null,
  thresholdMs: number,
  state: Map<string, DropTransitionState>,
): DropSeverityDecision;

/**
 * Thin adapter that calls `logger.info` or `logger.warn` based on the decision.
 * Kept as a separate function so callers can unit-test the classification
 * without spying on the logger.
 */
export function emitDropLog(
  logger: Logger,
  decision: DropSeverityDecision,
  payload: Record<string, unknown>,
  message: string,
): void;
```

## Decision table

Let `threshold = 30 min`, `state[itemKey].lastSeverity` = previous severity (`info` by default if the key is absent).

| `ageMs`     | previous | new severity | `isTransitionEdge` | log level emitted |
|-------------|----------|--------------|--------------------|-------------------|
| null        | any      | `info`       | false              | `info` (fail-safe) |
| < threshold | `info`   | `info`       | false              | `info` (no repeat spam) |
| < threshold | `warn`   | `info`       | true               | `info` — **transition down**; single line |
| ≥ threshold | `info`   | `warn`       | true               | `warn` — **transition up**; single line |
| ≥ threshold | `warn`   | `warn`       | false              | `info` (no repeat spam — the wedge is already recorded once) |

Note the last row: once a `warn` has fired for a wedged itemKey, subsequent drops for the same itemKey fall back to `info` until the wedge clears. This is the "17 identical `warn`s" prevention. The reclaim log line (FR-008) is the operator's *ongoing* signal for the wedged state; the transition-edge `warn` is the *first alert*.

## Cleanup semantics

Callers MUST call `state.delete(itemKey)` when the itemKey exits in-flight for good (i.e. inside `RedisQueueAdapter.complete()`, `InMemoryQueueAdapter.complete()`, and the reclaim path of `RECLAIM_ORPHAN_SCRIPT`'s client wrapper). Monitor-side callers own their own state Map and MUST clean up on the same signal — but since monitors don't observe `complete()` directly, they clean up lazily: the next `classifyDropSeverity` call for an itemKey that isn't in flight anymore (ageMs = null) does NOT clear the state, but on the next successful `enqueueIfAbsent` the itemKey is back in flight with a fresh cycle, so the stale state doesn't matter. In practice the state Map size is bounded by concurrent-wedges-in-cluster, which is O(worker-count) ≈ 1-10.

## Interaction with the `lastUnresolvedThreadCount` pattern in `pr-feedback-monitor-service.ts`

The existing per-PR `lastUnresolvedThreadCount` Map at `pr-feedback-monitor-service.ts:73` tracks a **different** thing (unresolved-thread count transitions for the drop-gate log at `:284-286`). It's keyed by `${owner}/${repo}#${prNumber}` (per-PR).

The new `dropLogState` Map added to the same service is keyed by `${owner}/${repo}#${issueNumber}` (per-issue itemKey — since queue items are per-issue, not per-PR). The two Maps coexist without conflict.

## Test cases (in `__tests__/drop-log-helper.test.ts`)

- `T1: age=null → info, edge=false, state unchanged`.
- `T2: fresh entry, age<threshold, no state → info, edge=false`.
- `T3: fresh entry, age≥threshold, no state → warn, edge=true, state[itemKey]='warn'`.
- `T4: existing state='warn', age≥threshold → info, edge=false` (repeat suppression — critical for anti-spam).
- `T5: existing state='warn', age<threshold → info, edge=true` (clear transition).
- `T6: two itemKeys tracked independently — state[A]='warn' does not affect classifyDropSeverity(B)`.
- `T7: threshold boundary — ageMs === thresholdMs classifies as warn (≥ not >)`.
- `T8: emitDropLog dispatches to logger.info when severity='info'`.
- `T9: emitDropLog dispatches to logger.warn when severity='warn'`.
- `T10: emitDropLog passes the payload with `{ ageMs, ...caller-payload }` merged`.

## Invariants (asserted structurally)

- The helper never touches I/O. No `Date.now()`, no `console`, no `fs` — the caller passes `ageMs`.
- The helper never throws. Malformed state (e.g. wrong shape) causes it to default to `info` and reset the state (fail-safe).
- The `stateAfter` field is always returned so callers can `state.set(itemKey, decision.stateAfter)` in one line.
