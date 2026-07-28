# Contract: Handler↔monitor counter seam (D-1, D-2)

**Kind**: Cross-process wire-format extension on `PrFeedbackMetadata`.
**Files**:
- `packages/orchestrator/src/types/monitor.ts:38-43` (add `retryAttempt?: number` field).
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` (read at cycle start; use in disposition decision at the new B5/B6 branches).
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` (write at enqueue — see `contracts/monitor-short-circuit.md`).

## The core question — why not constructor injection?

FR-007 said the handler "MUST check the current retry counter for the `stateKey`" and left the mechanism to /plan:

> Handler reads the same in-memory counter the monitor writes (via constructor injection or a shared reference — mechanism deferred to /plan).

Both suggested mechanisms **cannot work** in this codebase:

- **`PrFeedbackHandler` construction** happens per-job inside a worker process, at `packages/orchestrator/src/worker/claude-cli-worker.ts:299`. That worker process is spawned when `packages/orchestrator/src/server.ts:314` (`if (isWorkerMode)`) fires.
- **`PrFeedbackMonitorService` construction** happens once per orchestrator process, at `packages/orchestrator/src/server.ts:539`. That branch is inside `if (!isWorkerMode && ...)` at `:508`.
- The two branches are **mutually exclusive** — worker mode and monitor mode never coexist in the same process. A shared `Map` reference passed via constructor injection would deserialize as an empty map on the worker side (no cross-process shared memory).

So the counter must be transmitted through a channel that already crosses the process boundary. That channel exists: the Redis queue.

## The chosen seam — `PrFeedbackMetadata.retryAttempt`

The monitor already hands the handler `prNumber` and `reviewThreadIds` via `PrFeedbackMetadata` (`packages/orchestrator/src/types/monitor.ts:38-43`). Adding one integer field costs nothing at the Redis / serialization layer:

```typescript
export interface PrFeedbackMetadata {
  prNumber: number;
  reviewThreadIds: number[];
  retryAttempt?: number;  // +1070 D-1
}
```

## Write side (monitor)

Every enqueue in `PrFeedbackMonitorService.processPrReviewEvent` sets `retryAttempt` to the current counter value:

```typescript
const currentRetries = this.fixerTimeoutRetryCount.get(stateKey) ?? 0;
const metadata: PrFeedbackMetadata = {
  prNumber,
  reviewThreadIds: unresolvedThreadIds,
  retryAttempt: currentRetries,
};
```

Fires for BOTH the retry-eligible branch (after incrementing) AND the normal dispatch path. Rationale: a fresh review coming in after a partial-completion chain (Case C never fired between them) should still respect the accumulated budget — the handler correctly applies `blocked:fixer-timeout-repeat` on the next timeout without needing a special "post-partial" branch.

## Read side (handler)

At the top of `PrFeedbackHandler.handle` (near line 114 where `metadata` is destructured today), read the counter with a default of 0 for pre-#1070 QueueItems:

```typescript
const retryAttempt = metadata.retryAttempt ?? 0;
```

At the new B5/B6 disposition branches (see `data-model.md` §4), decide the label:

```typescript
if (timedOut && hasChanges) {
  const disposition = retryAttempt < 2 ? 'fixer-timeout' : 'fixer-timeout-repeat';
  const label = retryAttempt < 2
    ? 'blocked:fixer-timeout'
    : 'blocked:fixer-timeout-repeat';

  this.logger.warn(
    {
      prNumber, issueNumber, owner, repo,
      disposition,
      retryAttempt,
      exitCode,
      cliCompleted: false,
    },
    disposition === 'fixer-timeout'
      ? 'CLI timed out with partial push — applying blocked:fixer-timeout (retry eligible)'
      : 'CLI timed out with partial push after retry budget exhausted — applying blocked:fixer-timeout-repeat (terminal)',
  );
  await this.addLabelHelper(github, owner, repo, issueNumber, label);
  return;
}
```

The B4 branch (`timedOut && !hasChanges`) is decided WITHOUT reading `retryAttempt` — zero-commit timeouts are terminal regardless of budget (Q3=C):

```typescript
if (timedOut && !hasChanges) {
  this.logger.warn(
    {
      prNumber, issueNumber, owner, repo,
      disposition: 'timeout-no-progress',
      retryAttempt,   // logged for observability but doesn't influence the label
      exitCode,
      cliCompleted: false,
    },
    'CLI timed out without pushing any commit — applying blocked:fixer-timeout-no-progress (terminal)',
  );
  await this.addLabelHelper(github, owner, repo, issueNumber, 'blocked:fixer-timeout-no-progress');
  return;
}
```

## Backwards compatibility

`retryAttempt?: number` is intentionally optional. A rolling deploy where the monitor updates first but a worker hasn't restarted yet leaves the field undefined on the worker's read — the `?? 0` default treats those as "original cycle" (correct — there was no retry model before, so any pre-existing item can only be its "first" attempt).

A reverse rolling deploy (worker updates first, monitor still on the old version) is safe because the worker will read `retryAttempt: undefined → 0` on every item — behavior identical to today.

## What is NOT this seam

- The counter's **storage** lives on the monitor side only (Q1=A). Handler does not hold state across cycles — it is constructed per-job.
- The counter's **reset** lives on the monitor side only (Case C at `pr-feedback-monitor-service.ts:296-317`, per D-5). Handler does not signal reset — Disposition A doesn't need to send anything to the monitor.
- The handler's `retryAttempt` value is a **snapshot** taken at dispatch time. If the monitor's counter changes between dispatch and handler execution (e.g., a Case C reset between polls), the handler still sees the snapshot — this is fine because Case C only fires when all threads are resolved, which means the handler has no work to do anyway (the QueueItem was already dispatched).
