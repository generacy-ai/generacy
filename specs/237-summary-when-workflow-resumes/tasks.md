# Tasks: Add agent:in-progress Label on Workflow Resume

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)

---

## Phase 1: Core Implementation

### T001 [DONE] [US1, US2] Update LabelManager.onResumeStart() to add agent:in-progress label
**File**: `packages/orchestrator/src/worker/label-manager.ts`
**Lines**: 162-167 (after existing removal logic)

- Add comment explaining the label addition: `// Add agent:in-progress to reflect active workflow state`
- Add info-level log message: `this.logger.info({ issue: this.issueNumber }, 'Resume: adding agent:in-progress label')`
- Add GitHub API call: `await this.github.addLabels(this.owner, this.repo, this.issueNumber, ['agent:in-progress'])`
- Ensure code is within the existing `retryWithBackoff()` block for atomicity

**Acceptance**:
- [ ] Label addition happens after label removal in same retry block
- [ ] Log message format matches existing patterns (see onPhaseStart line 45-48)
- [ ] Total addition is exactly 4 lines (comment + log + addLabels call + blank line for spacing)

---

## Phase 2: Test Updates

### T002 [DONE] [US2] Update existing test: "removes waiting-for:* and agent:paused labels when present"
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
**Lines**: ~166-167 (after existing assertions)

- Add new assertion to verify `addLabels` is called with `agent:in-progress`
- Use exact format: `expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['agent:in-progress'])`
- Ensure assertion is added after existing `removeLabels` assertion

**Acceptance**:
- [ ] Test verifies both label removal AND addition
- [ ] Assertion uses correct mock object (`mockGithub.addLabels`)
- [ ] Test still validates the original behavior (stale label removal)

### T003 [DONE] [US2] Update edge case test: "does not call removeLabels when no stale labels exist"
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
**Lines**: ~182-183 (after existing assertion)

- Keep existing assertion verifying `removeLabels` is NOT called
- Add new assertion verifying `addLabels` IS called even when no stale labels exist
- Use format: `expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, ['agent:in-progress'])`

**Acceptance**:
- [ ] Test validates that `agent:in-progress` is added unconditionally
- [ ] Edge case handles scenario where labels were manually cleaned
- [ ] Both assertions pass (removeLabels not called, addLabels called)

---

## Phase 3: Verification

### T004 [DONE] [US1, US2] Run unit test suite
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
**Command**: `cd packages/orchestrator && pnpm test -- label-manager.test.ts`

- Verify the 2 updated tests pass with new assertions
- Verify all 20+ existing tests still pass (no regression)
- Check test output for any warnings or deprecations

**Acceptance**:
- [ ] ✓ `onResumeStart > removes waiting-for:* and agent:paused labels when present`
- [ ] ✓ `onResumeStart > does not call removeLabels when no stale labels exist`
- [ ] All other label-manager tests pass unchanged
- [ ] No test failures or errors in output

### T005 [DONE] [US1] Manual integration test on test issue
**Prerequisites**: Development stack running, test environment configured

**Test scenario**:
1. Create test issue with `process:speckit-feature` label
2. Wait for workflow to hit clarification gate (should add `agent:paused`, `waiting-for:clarification`)
3. Provide clarification answers to trigger resume event
4. **Verify**: During plan/implement phases, issue shows `agent:in-progress` label
5. **Verify**: Label transitions correctly throughout workflow
6. **Verify**: On completion, `agent:in-progress` is removed

**Acceptance**:
- [ ] `agent:paused` → `agent:in-progress` transition occurs on resume
- [ ] `agent:in-progress` persists during active phase execution
- [ ] Label is visible in GitHub issue UI during execution
- [ ] No orphaned `agent:in-progress` labels after completion
- [ ] Logs show "Resume: adding agent:in-progress label" message

### T006 [DONE] [P] [US2] Verify no regression in process event flow
**Command**: `cd packages/orchestrator && pnpm test`

- Run full orchestrator test suite to ensure no regressions
- Verify process event tests still pass unchanged
- Check that label-monitor-service tests are unaffected

**Acceptance**:
- [ ] All orchestrator tests pass (100% success rate)
- [ ] No changes required to process event path tests
- [ ] Label state machine consistency maintained across both entry points

---

## Phase 4: Documentation & Deployment

### T007 [DONE] [P] Update specification status
**File**: `/workspaces/generacy/specs/237-summary-when-workflow-resumes/spec.md`

- Update status from "Draft" to "Implemented"
- Add implementation completion date
- Mark all acceptance criteria as completed

**Acceptance**:
- [ ] Status field updated to "Implemented"
- [ ] Date stamp added
- [ ] All checkboxes in acceptance criteria marked

### T008 [DONE] [P] Create commit with descriptive message
**Files**:
- `packages/orchestrator/src/worker/label-manager.ts`
- `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`

**Commit message format**:
```
fix: add agent:in-progress label on workflow resume

When workflows resume after hitting a gate (e.g., clarification),
the label state machine now correctly transitions from agent:paused
to agent:in-progress, ensuring issues accurately reflect active
execution state.

This fixes the gap where resume events would remove agent:paused
but never add agent:in-progress, leaving issues without an agent
status label during active phases.

Changes:
- LabelManager.onResumeStart() now adds agent:in-progress after
  removing stale labels (waiting-for:*, agent:paused)
- Updated tests to verify label addition in both normal and edge cases
- Both operations wrapped in same retryWithBackoff() for atomicity

Closes #237

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**Acceptance**:
- [ ] Commit message explains the "why" not just the "what"
- [ ] References issue #237
- [ ] Includes Co-Authored-By line
- [ ] Staged files are correct (2 files only)

### T009 [DONE] Create pull request
**Base branch**: `develop`
**Title**: `fix: add agent:in-progress label on workflow resume (#237)`

**PR body**:
```markdown
## Summary
Fixes the label state machine gap where workflow resume events remove `agent:paused` but never add `agent:in-progress`, leaving issues without an agent status label during active execution.

**Current behavior**: `agent:paused` → (removed) → no agent status label
**Fixed behavior**: `agent:paused` → `agent:in-progress` → (completion/error/gate)

## Changes
- Modified `LabelManager.onResumeStart()` to add `agent:in-progress` after removing stale labels
- Updated 2 unit tests to verify the new label addition behavior
- Both label removal and addition wrapped in same `retryWithBackoff()` for atomicity

## Testing
- ✅ Unit tests pass (2 updated tests + all existing tests)
- ✅ Manual integration test verified correct label transitions
- ✅ No regression in process event flow

## Related
- Closes #237
- Related to #215 (introduced `onResumeStart()` for gate label cleanup)
- Related to #235 (example issue that would benefit from this fix)

## Test plan
- [x] Unit tests pass
- [x] Manual test: trigger gate → resume → verify `agent:in-progress` during execution
- [x] Verified no orphaned labels after completion
- [ ] Deploy to staging and monitor for 24 hours
- [ ] Verify on production with real workflow

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Acceptance**:
- [ ] PR created with correct base branch
- [ ] PR description includes summary, changes, testing, and related issues
- [ ] PR references issue #237
- [ ] PR includes test plan checklist

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
```
Phase 1 (Core Implementation)
  → Phase 2 (Test Updates)
  → Phase 3 (Verification)
  → Phase 4 (Documentation & Deployment)
```

**Parallel opportunities within phases**:
- **Phase 2**: T002 and T003 are independent test updates (can be done in parallel if using split editor)
- **Phase 3**: T004 must complete before T005, but T006 can run in parallel with T005
- **Phase 4**: T007 and T008 can be done in parallel, T009 depends on T008 completion

**Critical path** (minimum sequential tasks):
```
T001 → T002 → T004 → T005 → T008 → T009
```

**Estimated timeline**:
- Phase 1: 5 minutes
- Phase 2: 10 minutes
- Phase 3: 15 minutes
- Phase 4: 30 minutes
- **Total**: ~60 minutes

---

## Risk Mitigation Checklist

- [ ] **R1**: Both label operations in same `retryWithBackoff()` block (atomicity)
- [ ] **R2**: No new API calls added (uses existing `addLabels` method)
- [ ] **R3**: Tests mock `sleep()` to avoid timing dependencies
- [ ] **R4**: Zero changes to process event path (regression prevented)
- [ ] **R5**: `addLabels()` is idempotent (safe to call multiple times)
- [ ] **R6**: Integration test validates full label state machine

---

## Success Metrics (Post-Deployment)

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Resume events show `agent:in-progress` | 100% | Monitor 10 workflow resumes, verify label present |
| No regression in process events | 100% | All existing tests pass |
| Test coverage for `onResumeStart()` | 100% | Coverage report shows `addLabels` call tested |
| Production orphaned labels | 0 | Grafana query after 24 hours |

---

*Generated by Claude Code on 2026-02-24*
