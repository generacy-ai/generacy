# Feature Specification: Add agent:in-progress Label on Workflow Resume

**Branch**: `237-summary-when-workflow-resumes` | **Date**: 2026-02-24 | **Status**: Implemented | **Completed**: 2026-02-24

## Summary

When a workflow resumes after hitting a gate (e.g., after clarification answers are received), the issue label should transition from `agent:paused` to `agent:in-progress` to accurately reflect the workflow's active state. Currently, the `agent:paused` label is removed but `agent:in-progress` is never added, causing issues to incorrectly show as paused while the agent is actively executing.

**Current behavior**: `agent:paused` → (removed) → no agent status label
**Expected behavior**: `agent:paused` → `agent:in-progress` → (completion/error/gate)

## User Stories

### US1: Accurate Agent Status Visibility

**As a** user monitoring workflow progress,
**I want** the issue labels to accurately reflect when the agent is actively processing after a resume event,
**So that** I can see at a glance whether the workflow is paused, active, errored, or complete without needing to check internal logs.

**Acceptance Criteria**:
- [x] When a resume event is processed, `agent:paused` is removed from the issue
- [x] When a resume event is processed, `agent:in-progress` is added to the issue
- [x] Label transition occurs before the worker starts executing phases
- [x] Label state is consistent with other workflow entry points (process events already add `agent:in-progress`)
- [x] Issue #235 (or similar resume scenarios) shows `agent:in-progress` during plan/implement phases after clarification

### US2: Consistent Label State Machine

**As a** developer maintaining the orchestrator,
**I want** resume events to follow the same label state machine as process events,
**So that** label transitions are predictable and debugging workflow state is easier.

**Acceptance Criteria**:
- [x] Resume events follow the same `agent:in-progress` → phase labels → completion/error pattern as process events
- [x] `onResumeStart()` in `LabelManager` adds `agent:in-progress` after removing stale labels
- [x] Unit tests verify that `onResumeStart()` adds `agent:in-progress`
- [x] No regression in existing label behavior (process events, gates, errors, completion)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `LabelManager.onResumeStart()` must add `agent:in-progress` label after removing `waiting-for:*` and `agent:paused` labels | P0 | Core fix — ensures resume events set agent status correctly |
| FR-002 | Label addition must occur within the same `retryWithBackoff` call that removes stale labels | P0 | Ensures atomic operation and retry consistency |
| FR-003 | Label addition must happen before `onPhaseStart()` is called in the worker phase loop | P1 | Maintains correct label state: status before phase |
| FR-004 | `onResumeStart()` must log the addition of `agent:in-progress` at info level | P2 | Consistency with other label operations for debugging |
| FR-005 | Unit tests must verify `agent:in-progress` is added when stale labels exist | P1 | Prevents regression |
| FR-006 | Unit tests must verify `agent:in-progress` is added even when no stale labels exist | P1 | Edge case coverage: resume after manual label cleanup |

## Technical Design

### Root Cause Analysis

The gap occurs in two locations:

1. **`label-monitor-service.ts:processLabelEvent()`** (lines 301-328)
   For `process` events, adds `agent:in-progress` immediately after enqueuing. For `resume` events, defers all label management to the worker with a comment: "waiting-for:* label removal for resume events is handled by the worker".

2. **`label-manager.ts:onResumeStart()`** (lines 145-164)
   Removes `waiting-for:*` and `agent:paused` but never adds `agent:in-progress`.

### Proposed Fix

Modify `LabelManager.onResumeStart()` to add `agent:in-progress` after removing stale labels:

```typescript
async onResumeStart(): Promise<void> {
  await this.retryWithBackoff(async () => {
    const issue = await this.github.getIssue(this.owner, this.repo, this.issueNumber);
    const currentLabels = issue.labels.map((l) =>
      typeof l === 'string' ? l : l.name,
    );

    const labelsToRemove = currentLabels.filter(
      (l) => l.startsWith('waiting-for:') || l === 'agent:paused',
    );

    if (labelsToRemove.length > 0) {
      this.logger.info(
        { labels: labelsToRemove, issue: this.issueNumber },
        'Resume: removing waiting-for and agent:paused labels',
      );
      await this.github.removeLabels(this.owner, this.repo, this.issueNumber, labelsToRemove);
    }

    // Add agent:in-progress to reflect active workflow state
    this.logger.info(
      { issue: this.issueNumber },
      'Resume: adding agent:in-progress label',
    );
    await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
  });
}
```

### Alternative Considered

Adding `agent:in-progress` in `label-monitor-service.ts:processLabelEvent()` for resume events (mirroring the process event path at lines 313-316). This was rejected because:
- `onResumeStart()` already owns the transition from paused → active state
- Keeps label removal and addition atomic within the same retry block
- Avoids race conditions between monitor service and worker

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Resume events show `agent:in-progress` | 100% | Manual testing: trigger gate, resume, verify label during execution |
| SC-002 | No regression in process event labels | 100% | Existing unit tests pass without modification |
| SC-003 | Test coverage for `onResumeStart()` | 100% | New test case verifies `addLabels` call with `agent:in-progress` |
| SC-004 | Label state consistency | 100% | Both process and resume paths result in `agent:in-progress` before phase execution |

## Assumptions

- The worker's `onResumeStart()` is always called before the phase loop begins (verified in worker implementation)
- `GitHubClient.addLabels()` is idempotent (adding an already-present label is safe)
- The retry logic in `retryWithBackoff()` applies to both `removeLabels` and `addLabels` operations when wrapped together
- No other code path expects `agent:in-progress` to be absent during resume events

## Out of Scope

- Changing label behavior for process events (already working correctly)
- Modifying `label-monitor-service.ts` label management for resume events (deferred to worker by design)
- Adding new label states or transitions beyond the existing state machine
- Changing gate detection or resume trigger logic
- Backfilling historical issues with corrected labels

## Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `packages/orchestrator/src/worker/label-manager.ts` | Add `agent:in-progress` in `onResumeStart()` | ~162-163 |
| `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` | Update test to verify `addLabels` call | ~148-167 |

## Testing Plan

### Unit Tests

1. **Update existing `onResumeStart` test** (line 149):
   Verify `addLabels` is called with `['agent:in-progress']` after `removeLabels`

2. **Add edge case test**:
   When no stale labels exist, verify `agent:in-progress` is still added

3. **Add retry test**:
   Verify `addLabels` is retried on failure within the same `retryWithBackoff` block

### Integration Test

Manually verify on a test issue:
1. Add `process:speckit-feature` label to trigger workflow
2. Let workflow hit clarification gate (should add `agent:paused`)
3. Provide clarification answers (triggers resume)
4. Verify `agent:in-progress` appears during plan/implement phases
5. Verify label is removed on completion

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Race condition between label removal and addition | Medium | Low | Both operations wrapped in single `retryWithBackoff` call |
| GitHub API rate limiting | Low | Low | Operations already batched; no additional API calls introduced |
| Test flakiness in retry scenarios | Low | Medium | Mock `sleep()` in tests to avoid timing dependencies |
| Regression in process event flow | High | Very Low | Existing tests cover process events; no changes to that path |

---

*Generated by speckit*
