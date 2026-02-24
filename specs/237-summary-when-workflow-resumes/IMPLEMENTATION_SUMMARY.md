# Implementation Summary

**Feature**: Add agent:in-progress Label on Workflow Resume
**Branch**: `237-summary-when-workflow-resumes`
**Complexity**: Low (2 files, +6 lines)
**Estimated Time**: ~1 hour

## Quick Overview

**Problem**: When workflows resume after hitting a gate, the `agent:paused` label is removed but `agent:in-progress` is never added, leaving issues without an agent status label during active execution.

**Solution**: Add `agent:in-progress` label in `LabelManager.onResumeStart()` immediately after removing stale labels.

**Impact**:
- Makes resume events consistent with process events (both show `agent:in-progress`)
- Fixes label state machine gap identified in issue #235
- Zero breaking changes, minimal code footprint

## Implementation at a Glance

### Files to Modify

1. **`packages/orchestrator/src/worker/label-manager.ts`** (lines 162-167)
   - Add 4 lines to `onResumeStart()` method
   - Action: Call `addLabels(['agent:in-progress'])` after removing stale labels

2. **`packages/orchestrator/src/worker/__tests__/label-manager.test.ts`** (lines 166, 182)
   - Add 2 assertions (one per test case)
   - Action: Verify `addLabels` called with `['agent:in-progress']`

### Code Change Preview

```typescript
// label-manager.ts:onResumeStart() — after line 161
if (labelsToRemove.length > 0) {
  await this.github.removeLabels(/* ... */);
}

// ↓↓↓ ADD THESE 4 LINES ↓↓↓
// Add agent:in-progress to reflect active workflow state
this.logger.info(
  { issue: this.issueNumber },
  'Resume: adding agent:in-progress label',
);
await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress']);
// ↑↑↑ END NEW CODE ↑↑↑
```

## Testing Strategy

### Unit Tests (Automated)
```bash
cd packages/orchestrator
pnpm test -- label-manager.test.ts
```

**Expected**: 20+ tests pass, including 2 updated `onResumeStart` tests

### Manual Integration Test (5 minutes)
1. Create test issue with `process:speckit-feature` label
2. Wait for clarification gate (adds `agent:paused`)
3. Provide clarification (triggers resume)
4. **✓ Verify**: Issue shows `agent:in-progress` during plan/implement phases
5. **✓ Verify**: Label removed on workflow completion

## Key Technical Decisions

| Decision | Why |
|----------|-----|
| Add label in `onResumeStart()` (not monitor service) | Keeps paused→active transition atomic in worker. Avoids race conditions. |
| Always add label (even if no stale labels) | Handles edge case: manual cleanup before resume. Simpler logic. |
| Wrap both operations in same `retryWithBackoff()` | Ensures atomicity — both retry together on failure. |
| Use info-level logging | Consistent with other label operations. Critical for debugging. |

## Dependencies

**Zero new dependencies**. Uses existing:
- `GitHubClient.addLabels()` — already used throughout codebase
- `retryWithBackoff()` — existing retry logic (3 attempts, exponential backoff)
- Vitest — existing test framework

## Risk Assessment

**Overall Risk**: ✅ **LOW**

| Risk | Mitigation |
|------|------------|
| Race condition between removal/addition | Both operations in same retry block |
| GitHub API rate limiting | No extra API calls (addLabels batches labels) |
| Test flakiness | Mock `sleep()` to bypass delays (existing pattern) |
| Regression in process events | Zero changes to that code path |
| Label already exists | `addLabels()` is idempotent (safe) |

**Rollback**: Single commit revert (2 files changed)

## Success Criteria

✅ Resume events show `agent:in-progress` during execution
✅ All existing tests pass (no regression)
✅ New test assertions verify `addLabels` called
✅ Manual integration test passes

## Documentation

**Artifacts Created**:
- ✅ `plan.md` — Comprehensive implementation plan
- ✅ `research.md` — Retry logic and atomicity analysis
- ✅ `IMPLEMENTATION_SUMMARY.md` — This document

**Next Steps**:
1. Implement changes per plan.md
2. Run unit tests
3. Perform manual integration test
4. Create PR for review
5. Deploy to staging → production
6. Update spec.md status to "Implemented"

---

**Ready to implement?** Follow the detailed steps in `plan.md`.

**Questions about retry logic?** See technical analysis in `research.md`.
