# Contract: Monitor short-circuit ordering — retry-eligible branch precedes `blocked:*` skip (D-4, Assumption 5)

**Kind**: Internal control-flow change in `PrFeedbackMonitorService.processPrReviewEvent`.
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`.
**Insertion point**: **Between** the `getIssueLabels` fetch at lines 363-372 (which populates `issueLabels: string[]`) and the current `blocked:*` skip check at lines 373-389.

## Before

```typescript
// pr-feedback-monitor-service.ts:363-389 (excerpt)
let issueLabels: string[];
try {
  issueLabels = await client.getIssueLabels(owner, repo, issueNumber);
} catch (error) {
  this.logger.warn(...);
  issueLabels = [];
}
const blockedLabel = issueLabels.find(l => l.startsWith('blocked:'));
if (blockedLabel) {
  this.logger.info(...);
  this.lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length);
  return false;
}
```

## After

```typescript
// pr-feedback-monitor-service.ts:363-389 (excerpt with retry-eligible branch inserted)
let issueLabels: string[];
try {
  issueLabels = await client.getIssueLabels(owner, repo, issueNumber);
} catch (error) {
  this.logger.warn(...);
  issueLabels = [];
}

// #1070 FR-006 / D-4: retry-eligible check fires BEFORE the blocked:*
// short-circuit. Preserves Assumption 5 — any UNRECOGNIZED blocked:* label
// still pauses the monitor; only the specific `blocked:fixer-timeout`
// (retry-eligible) is carved out here.
if (issueLabels.includes('blocked:fixer-timeout')) {
  const priorRetries = this.fixerTimeoutRetryCount.get(stateKey) ?? 0;
  if (priorRetries < 2) {
    // Budget remaining — remove the retry-eligible label and continue to
    // the normal enqueue path with an incremented counter.
    try {
      await client.removeLabels(owner, repo, issueNumber, ['blocked:fixer-timeout']);
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to remove blocked:fixer-timeout before retry dispatch — non-fatal, will re-check on next poll',
      );
      // Fall through to the blocked:* skip check below — safer than
      // dispatching with the label still present (would race the handler's
      // own removeLabels call).
    }
    this.fixerTimeoutRetryCount.set(stateKey, priorRetries + 1);
    this.logger.info(
      {
        owner, repo, prNumber, issueNumber,
        priorRetries,
        newRetries: priorRetries + 1,
        gate: 'blocked-fixer-timeout-retry-dispatch',
      },
      'Dispatching auto-retry after blocked:fixer-timeout (Q5=C, max 2)',
    );
    // Do NOT return — fall through to the normal enqueue path.
  } else {
    // priorRetries >= 2. Defense in depth: handler should have applied
    // blocked:fixer-timeout-repeat and this branch shouldn't fire. If it
    // does, log and fall through to the blocked:* skip check below.
    this.logger.warn(
      {
        owner, repo, prNumber, issueNumber,
        priorRetries,
        gate: 'blocked-fixer-timeout-budget-exhausted',
      },
      'blocked:fixer-timeout present but retry budget exhausted — expected blocked:fixer-timeout-repeat (handler bug?)',
    );
    // Fall through to the blocked:* skip check below (which will match).
  }
}

const blockedLabel = issueLabels.find(l => l.startsWith('blocked:'));
if (blockedLabel) {
  this.logger.info(...);
  this.lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length);
  return false;
}
```

## Invariants preserved

1. **Assumption 5**: any `blocked:*` label the retry branch does NOT recognize still pauses the monitor. The existing `.find(l => l.startsWith('blocked:'))` gate is unchanged.
2. **Idempotent-state hygiene**: the retry branch does NOT touch `lastUnresolvedThreadCount`. That map's write is still owned by the enqueue path (lines 387 and 395). Same for `lastZeroTrustedState`.
3. **Failure isolation**: label removal failure warns and falls through — the retry does NOT proceed with the label still present. Safer than the race the handler's own removal call would create.

## New enqueue-path change — attach `retryAttempt`

Immediately below the retry branch above, the enqueue path at lines 414-428 attaches the current counter value to the QueueItem metadata:

```typescript
const currentRetries = this.fixerTimeoutRetryCount.get(stateKey) ?? 0;
const metadata: PrFeedbackMetadata = {
  prNumber,
  reviewThreadIds: unresolvedThreadIds,
  retryAttempt: currentRetries,   // +1070 D-1 — 0 for original dispatches
};
```

This fires for **every** enqueue, not just retry-branch dispatches. Non-retry dispatches get `retryAttempt: 0` (fresh trigger, no auto-retries yet) unless a partial-completion chain left the counter positive without a Case C reset — in which case the handler correctly applies `blocked:fixer-timeout-repeat` on the next timeout (per D-2).

## Reset site (D-5)

Case C at `pr-feedback-monitor-service.ts:296-317` gains one line:

```typescript
this.lastUnresolvedThreadCount.set(stateKey, 0);
this.lastZeroTrustedState.set(stateKey, false);
this.fixerTimeoutRetryCount.delete(stateKey);   // +1070 D-5 — Q5=C progress-only reset
```

`Map.delete` on an absent key is a no-op (returns `false`) — safe to unconditionally invoke.

## Test coverage (SC-003 / SC-003a / SC-003b)

Extend `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts` with:
- SC-002 base case: two-cycle retry that succeeds on the second cycle.
- SC-003: three timeouts in a row → third cycle carries `retryAttempt: 2`; monitor stops dispatching after third.
- SC-003a: first cycle is a `hasChanges: false` timeout → handler applies `blocked:fixer-timeout-no-progress`; monitor's next poll hits the generic `blocked:*` skip; counter is NEVER incremented (retry-eligible branch doesn't match).
- SC-003b: counter resets after Case C fires between chains.
- Failure-isolation case: `removeLabels` throws → retry branch falls through → generic `blocked:*` skip matches → counter NOT incremented on that poll (no dispatch happened).
