# T005 Manual Integration Test Summary

**Task**: T005 [US1] Manual integration test on test issue
**Feature**: #237 - Add agent:in-progress Label on Workflow Resume
**Status**: Ready for Manual Testing
**Date**: 2026-02-24

## Implementation Status

✅ **Code Implementation Complete**
- `LabelManager.onResumeStart()` now adds `agent:in-progress` label (lines 165-170)
- Unit tests updated and passing (19/19 tests pass)
- Log message added: "Resume: adding agent:in-progress label"

✅ **Automated Tests Complete**
- T001: Core implementation ✓
- T002: Unit test update ✓
- T003: Edge case test ✓
- T004: Test suite verification ✓

## Manual Test Required

Task T005 requires **manual verification** in a live environment because it involves:

1. **Real GitHub Issues**: Creating actual issues in a repository
2. **Live Workflow Execution**: Running the orchestrator service with GitHub webhooks
3. **Interactive Gates**: Waiting for clarification gates and providing answers
4. **Label Observation**: Watching real-time label changes on GitHub UI

### Why Manual Testing is Necessary

While unit tests verify the **code logic**, they cannot validate:
- **End-to-end workflow**: Full resume event flow through GitHub → webhook → orchestrator → worker
- **Label visibility**: Actual label appearance/timing in GitHub UI
- **Race conditions**: Real-world timing between label removal and addition
- **User experience**: Developer observing label transitions during active workflow

## Test Artifacts Provided

### 1. Detailed Test Guide
**File**: `manual-integration-test.md`

A comprehensive 7-step test procedure with:
- Prerequisites checklist
- Step-by-step instructions
- Expected vs actual observation sections
- Screenshot capture points
- Log verification steps
- Acceptance criteria checklist

**Use this for**: First-time testers, formal QA validation, bug investigation

### 2. Quick Reference
**File**: `tasks.md` (T005 section)

Quick test overview with:
- Core test steps (5 steps)
- Key acceptance criteria
- Link to detailed guide

**Use this for**: Developers familiar with the workflow, quick smoke tests

## Test Execution Options

### Option 1: Full Manual Test (Recommended)
Follow `manual-integration-test.md` for comprehensive validation:
- Validates all acceptance criteria
- Documents evidence (logs, screenshots)
- Suitable for QA sign-off
- **Time**: ~20-30 minutes

### Option 2: Quick Smoke Test
Use tasks.md T005 for rapid verification:
- Verifies core behavior only
- Minimal documentation
- Suitable for dev testing during iteration
- **Time**: ~10 minutes

### Option 3: Automated Integration Test (Future)
Not currently implemented. Would require:
- Test repository with webhook configuration
- Orchestrator test harness
- GitHub API mocking for label operations
- Simulated gate/resume workflow

## What to Verify

### Critical Verification Points

1. **Label Transition** (Primary Goal)
   ```
   BEFORE resume: [agent:paused, waiting-for:clarification]
   AFTER resume:  [agent:in-progress]  ← Must see this!
   ```

2. **Log Message** (Implementation Proof)
   ```json
   {
     "level": "info",
     "issue": 123,
     "msg": "Resume: adding agent:in-progress label"
   }
   ```

3. **Timing** (State Machine Correctness)
   - Label added BEFORE phase execution starts
   - Label visible DURING active workflow execution
   - Label removed AFTER workflow completion

## Success Criteria

**The test PASSES if**:
- [ ] All 7 acceptance criteria in manual-integration-test.md are checked
- [ ] Screenshots show `agent:in-progress` during execution
- [ ] Logs contain "Resume: adding agent:in-progress label"
- [ ] No orphaned labels after completion

**The test FAILS if**:
- Issue shows no agent status label during resume execution
- `agent:paused` persists after resume
- `agent:in-progress` appears but is removed too early
- Errors in orchestrator logs during label operations

## Known Limitations

This manual test does NOT cover:
- **High volume**: Multiple simultaneous resumes
- **Error paths**: GitHub API failures during label operations
- **Edge cases**: Manual label manipulation during resume
- **Performance**: Label update latency measurement

These would require automated integration tests (Option 3 above).

## Next Steps for Tester

1. **Setup Environment**
   ```bash
   # Start development stack
   /workspaces/tetrad-development/scripts/stack start
   source /workspaces/tetrad-development/scripts/stack-env.sh

   # Start orchestrator
   cd packages/orchestrator
   pnpm dev
   ```

2. **Open Test Guide**
   ```bash
   # View the detailed test procedure
   cat manual-integration-test.md
   ```

3. **Create Test Issue**
   ```bash
   # Replace with your test repository
   gh issue create \
     --repo owner/repo \
     --title "Test: #237 Resume Label Transition" \
     --label "process:speckit-feature"
   ```

4. **Follow Steps 1-7** in `manual-integration-test.md`

5. **Record Results** in the test guide

6. **Report Back**
   - If PASS: Mark T005 complete, proceed to T006
   - If FAIL: Document issue, create bug report, block deployment

## Questions?

- **"Can I skip this test?"**: No - this validates the core user story (US1: Accurate Agent Status Visibility)
- **"Can I automate this?"**: Not easily - requires live GitHub integration
- **"What if I don't have a test repo?"**: Use a personal repository or create a test organization
- **"How long does this take?"**: 20-30 minutes for full test, 10 minutes for quick smoke test

## References

- **Specification**: `spec.md`
- **Implementation Plan**: `plan.md`
- **Task Breakdown**: `tasks.md`
- **Test Guide**: `manual-integration-test.md`
- **Code Changes**:
  - `packages/orchestrator/src/worker/label-manager.ts:165-170`
  - `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`

---

**Status**: ✅ Ready for manual testing
**Blocker**: None - all prerequisites complete
**Assignee**: QA / Developer with test environment access
