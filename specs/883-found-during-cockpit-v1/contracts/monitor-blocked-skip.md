# Contract: PrFeedbackMonitorService — blocked-label skip

## Where the check runs

Inside `PrFeedbackMonitorService.processPrReviewEvent(...)`, after the trust-live check (Case A branch at ~line 308) and **before** `addLabels(waiting-for:address-pr-feedback)` (line 328).

Order matters:

1. Trust filter runs first — an untrusted-notice or trust-only-transition path must not be starved by a blocked check.
2. Blocked check runs second — decisively skip enqueue if the operator has paused the loop.
3. `addLabels(waiting-for:*)` and `enqueueIfAbsent` run only if the blocked check is clear.

## Predicate

```
issueLabels: string[] = await client.getIssueLabels(owner, repo, issueNumber)
blockedLabel = issueLabels.find(l => l.startsWith('blocked:'))
if (blockedLabel) → skip enqueue
```

The prefix `blocked:` is the sole matcher. No allow-list. Future `blocked:*` siblings inherit the skip semantics for free.

## Structured log on skip

```
{
  level: 'info',
  msg: 'Skipping PR-feedback enqueue while blocked:* label is present',
  owner, repo, prNumber, issueNumber,
  blockedLabel,
  unresolvedThreads: unresolvedThreadIds.length,
  reason: 'blocked-label-present',
}
```

Level is `info`, not `warn`: this is the intended operator-driven pause. `warn` is reserved for handler-side "the loop wanted to advance and couldn't".

## Idempotent-state hygiene

- `lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length)` is still called on the skip path. Rationale: the map exists for the #861 state-transition logging (`info` on transition, `debug` on steady-state). Skipping the update would make the next non-blocked poll look like a fresh transition even if the count is unchanged, cluttering logs.
- `lastZeroTrustedState.set(stateKey, false)` is not touched on the blocked path (trust state hasn't changed; blocked is orthogonal).
- `waiting-for:address-pr-feedback` is NOT added on the blocked path. Rationale: if it's already present, adding again is a no-op; if it's not present (operator removed it), the monitor should respect that state.

## Interaction with #879 in-flight dedupe

- `blocked:*` check runs before `queueManager.enqueueIfAbsent`. If blocked, the queue is never touched. In-flight dedupe cannot fire on a blocked skip.
- If a work item is in-flight when the operator adds `blocked:*` (e.g., via reviewing an old cycle), the in-flight cycle completes normally on its own outcome. The next poll sees `blocked:*` and skips re-enqueue. This is the intended shape — the operator wanted the loop paused, and the in-flight cycle's outcome resolves cleanly on its own terms.

## Test surface

Vitest unit tests (`packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`):

- **SC-003 skip:** Case A trust-live PR whose linked issue carries `blocked:stuck-feedback-loop`. Assert `enqueueIfAbsent` was not called, structured info log was emitted, `waiting-for:address-pr-feedback` was NOT added on this poll.
- **Prefix generality:** same shape as above, but the label is `blocked:something-else`. Assert same skip behavior.
- **No-blocked passthrough:** Case A trust-live PR whose linked issue does NOT carry any `blocked:*` label. Assert existing enqueue path fires; assert no skip log emitted.
- **Trust filter precedence:** zero-trusted PR whose linked issue also carries `blocked:stuck-feedback-loop`. Assert the untrusted-notice path runs (Case B semantics unchanged); the blocked check is not reached.
- **Idempotent-state hygiene:** blocked skip on a PR whose previous cycle had `unresolvedThreads = 3`, current cycle sees `unresolvedThreads = 3`. Assert map is updated, no transition log emitted on the next poll if the count stays at 3.

## Non-goals

- The monitor never removes `blocked:*` labels. That is exclusively the operator's action.
- The monitor does not distinguish between `blocked:stuck-feedback-loop` and other `blocked:*` labels. The prefix is the contract.
- The monitor does not emit an untrusted-notice-style "hey you're blocked" PR comment. The label is the surface; cockpit renders it.
