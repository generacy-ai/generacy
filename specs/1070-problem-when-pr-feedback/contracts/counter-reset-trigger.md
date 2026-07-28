# Contract: Counter reset trigger — Case C is the sole reset site (D-5, FR-013, Q5=C)

**Kind**: Internal state-machine invariant on `PrFeedbackMonitorService.fixerTimeoutRetryCount`.
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`.
**Rule**: `fixerTimeoutRetryCount.delete(stateKey)` is invoked at **exactly one** call site.

## The one reset site

Case C branch at `pr-feedback-monitor-service.ts:296-317` — where `totalUnresolvedThreads === 0`. One line added:

```typescript
// Case C: no unresolved threads at all — reset both state maps.
if (totalUnresolvedThreads === 0) {
  const previous = this.lastUnresolvedThreadCount.get(stateKey);
  const isTransition = previous === undefined || previous !== 0;
  const logFn = isTransition ? this.logger.info : this.logger.debug;
  logFn.call(
    this.logger,
    { owner, repo, prNumber, issueNumber, totalThreads, unresolvedThreads: 0, previousUnresolvedThreads: previous ?? null },
    isTransition ? 'No unresolved review threads (state change)' : 'No unresolved review threads — skipping',
  );
  this.lastUnresolvedThreadCount.set(stateKey, 0);
  this.lastZeroTrustedState.set(stateKey, false);
  this.fixerTimeoutRetryCount.delete(stateKey);   // +1070 D-5 — Q5=C progress-only reset
  return false;
}
```

## Explicitly-rejected reset sites

| Site | Why it would reset | Why we reject |
|---|---|---|
| Disposition A completion in the handler | "The current cycle succeeded" | Only guarantees ≥1 resolve success, not full resolution. Q5=C explicitly forbids: "resetting on 'threads fully resolved' (i.e., the work actually completed) is the right condition; resetting on 'any commit' is what makes A unbounded". |
| Any commit push landing | "The trigger made progress" | This is the SHA-keyed model Q5=C overturned. A fixer that times out never reaches the no-diff branch → every timeout cycle that writes any commit would reset a commit-keyed budget → unbounded loop. |
| Operator manually removes `blocked:fixer-timeout*` label | "The operator intervened" | Would let an operator's label-clear silently refill the budget without doing any work. Q5=C's intent is that only *actual completion* clears the budget. If an operator wants to force a fresh cycle, they can additionally resolve all remaining threads. |
| Handler explicitly calls a reset API | Same as above, plus adds handler→monitor coupling | Reject the coupling — handler is per-job and cannot see monitor state. Signalling reset would require another wire-format extension (opposite direction) for zero benefit over the natural Case C reset. |
| Fresh review comes in after an exhausted-retry chain | "New work starts a new budget" | Same rationale as operator-clear. Fresh reviews don't reset the budget — the operator must first resolve all outstanding threads (or accept `blocked:fixer-timeout-repeat` on the next timeout, which is the correct terminal signal for a trigger that legitimately cannot fit in the budget). |

## Handler is stateless w.r.t. reset

The handler never mutates the counter. It reads `retryAttempt` from `PrFeedbackMetadata` (baked in by the monitor at dispatch) and decides which label to apply. The counter's lifecycle is entirely on the monitor side — increment (retry-eligible dispatch) and delete (Case C). This is load-bearing for D-1's cross-process seam: if the handler could reset, it would need a channel to signal the monitor, and there is no natural such channel today.

## Correctness argument for "reset only on full resolution"

Q5=C's argument, restated: the counter tracks *timeouts-since-last-full-completion*. A partial success (Disposition A that resolves some but not all threads) is still an incomplete trigger. The next fresh review that lands on the same PR is part of the same "trigger episode" from the counter's perspective — the fixer is being asked to keep addressing feedback on the same PR without ever quite finishing.

If cycle 3 is a partial success, cycle 4 comes in (new reviews), and cycle 4 also times out — that's a genuine risk of the exact runaway Q5=C was designed to prevent. Cycle 4's `retryAttempt` correctly still reflects the accumulated counter, so cycle 4's handler applies `blocked:fixer-timeout-repeat` → terminal → operator intervention required. This is the correct outcome.

## Test coverage (SC-003b)

Extend `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` with a scenario:

1. Simulate 2 consecutive timeouts (Case B in the monitor → dispatch → handler applies `blocked:fixer-timeout`). Counter reaches 2.
2. Simulate a monitor poll where the fixture returns `totalUnresolvedThreads === 0` (Case C fires). Assert `fixerTimeoutRetryCount.get(stateKey) === undefined` afterward.
3. Simulate a NEW review event on the same PR. Expected: monitor's next enqueue attaches `retryAttempt: 0` (fresh trigger — budget restored).
4. Simulate 3 more timeouts. Expected: cycle 6 (the third post-reset timeout) applies `blocked:fixer-timeout-repeat` — matching SC-003b's timeline `[timeout, timeout, full-resolve, timeout, timeout, timeout]`.
