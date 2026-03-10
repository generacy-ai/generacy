# Feature Specification: Resume-After-Failure Retry Logic for Implement Phase

**Branch**: `359-summary-when-implement-phase` | **Date**: 2026-03-10 | **Status**: Draft

## Summary

When the implement phase fails (timeout, context exhaustion, crash), the orchestrator should detect partial progress, commit it, and retry with a fresh Claude session. The fresh session will skip already-completed tasks via the existing idempotency logic in `tasks.md`.

## Background

The orchestrator's phase loop (`packages/orchestrator/src/worker/phase-loop.ts`) currently treats implement phase failure as terminal — it marks the issue with `agent:error` and stops. But if the Claude session ran out of context after completing 5 of 7 tasks, those 5 tasks' changes may exist in the working tree (uncommitted, with tasks.md updated). A fresh session could finish the remaining 2 tasks.

This happened on generacy-ai/generacy-cloud#133: the agent completed all 7 implementation tasks but ran out of context while updating test files. Since no retry was attempted, all work was lost.

Combined with the incremental commits change (separate issue), this creates a robust recovery path: commits preserve progress, retry picks up where it left off.

## User Stories

### US1: Automatic Recovery from Implement Phase Failures

**As an** orchestrator system,
**I want** to detect partial progress after an implement phase failure and retry with a fresh session,
**So that** completed task work is not lost and the implementation can complete without manual intervention.

**Acceptance Criteria**:
- [ ] Implement phase failure with uncommitted changes triggers retry
- [ ] Retry uses a fresh Claude session (not the crashed/exhausted one)
- [ ] Already-completed tasks (marked `[X]` in tasks.md) are skipped on retry

### US2: Configurable Retry Limits

**As an** operator,
**I want** to configure the maximum number of implement phase retries,
**So that** I can tune the recovery behavior for my environment.

**Acceptance Criteria**:
- [ ] `maxImplementRetries` is a configurable value (default: 2)
- [ ] When all retries are exhausted, the existing `agent:error` path is triggered

### US3: Retry Status Visibility

**As a** developer monitoring a running workflow,
**I want** to see retry status updates in the GitHub issue comment,
**So that** I can tell whether the agent is recovering or has permanently failed.

**Acceptance Criteria**:
- [ ] Stage comment is updated to reflect retry attempt and count

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After implement phase failure, check for partial progress (uncommitted changes or recent commits) | P1 | Via `prManager.commitPushAndEnsurePr(phase)` |
| FR-002 | If partial progress detected and retry budget remains, retry with a fresh Claude session | P1 | Reset `currentSessionId = undefined` |
| FR-003 | Decrement phase index to re-run the implement phase | P1 | `i--; continue;` |
| FR-004 | Track retry count; do not exceed `config.maxImplementRetries` | P1 | Default: 2 |
| FR-005 | If no partial progress, fall through immediately to existing error handling | P1 | No retry on clean failures |
| FR-006 | Update the GitHub stage comment to reflect retry status | P2 | Log warn message at minimum |
| FR-007 | Add `maxImplementRetries` to orchestrator config schema | P1 | `z.number().int().min(0).max(5).default(2)` |

## Changes Required

### `packages/orchestrator/src/worker/phase-loop.ts`

After the phase failure check (~line 198), add implement-specific retry logic:

```typescript
// After: if (!result.success) {
if (phase === 'implement') {
  // Check if partial progress was made (uncommitted changes or recent commits)
  const { hasChanges } = await prManager.commitPushAndEnsurePr(phase);

  if (hasChanges && implementRetryCount < config.maxImplementRetries) {
    implementRetryCount++;
    currentSessionId = undefined; // Fresh session — don't resume crashed one
    this.logger.warn(
      { phase, retry: implementRetryCount, maxRetries: config.maxImplementRetries },
      'Implement phase failed with partial progress — retrying with fresh session',
    );
    i--; // Re-run this phase index
    continue;
  }
}
// ... existing error handling ...
```

### `packages/orchestrator/src/worker/config.ts`

Add retry configuration:

```typescript
/** Maximum retries for implement phase when partial progress is detected */
maxImplementRetries: z.number().int().min(0).max(5).default(2),
```

### Retry Semantics

- Only retry when `hasChanges` is true (partial progress detected)
- Always use a fresh session (`currentSessionId = undefined`) — the crashed session's context is corrupted/exhausted
- Maximum 2-3 retries (configurable via `maxImplementRetries`)
- Each retry benefits from existing task idempotency: completed tasks (marked `[X]` in `tasks.md`) are skipped
- If all retries exhausted, fall through to the existing error path (`agent:error` label)

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Implement phase retries on partial failure | 100% of cases with uncommitted changes | Observe retry log line and fresh session start |
| SC-002 | No retry on clean failure (no changes) | 0 spurious retries | Verify existing error path triggers immediately |
| SC-003 | Retry respects max limit | Never exceeds `maxImplementRetries` | Check retry counter logic |
| SC-004 | Config schema accepts `maxImplementRetries` | Zod validation passes | Unit test config parsing |

## Acceptance Criteria

- [ ] Implement phase failure with partial progress triggers automatic retry
- [ ] Retry uses a fresh Claude session (not the crashed one)
- [ ] Already-completed tasks are skipped on retry (existing idempotency)
- [ ] Maximum retry count is configurable (default: 2)
- [ ] No retry if no partial progress was made (immediate failure)
- [ ] Stage comment updated to reflect retry status
- [ ] All retries exhausted → existing error handling path

## Assumptions

- The incremental commits feature (separate issue) is either already merged or retry logic relies on uncommitted working-tree changes as the signal for partial progress
- `prManager.commitPushAndEnsurePr(phase)` returns `{ hasChanges: boolean }` or equivalent

## Out of Scope

- Retry logic for phases other than `implement`
- Automatic diagnosis of the root cause of failure
- Session resumption (always starts fresh — the crashed session is considered corrupted)

## References

- Root cause analysis: generacy-ai/generacy-cloud#133
- Related: incremental commits issue (ensures progress is committed before retry)
- `packages/orchestrator/src/worker/phase-loop.ts`
- `packages/orchestrator/src/worker/config.ts`

---

*Generated by speckit*
