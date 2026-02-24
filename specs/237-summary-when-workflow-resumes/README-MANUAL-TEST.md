# Manual Testing for Feature #237

**Quick Start Guide for Task T005**

## What You're Testing

Verify that when a workflow resumes after a gate (e.g., clarification), the issue correctly shows `agent:in-progress` label during execution.

**Fix**: The `LabelManager.onResumeStart()` method now adds `agent:in-progress` after removing `agent:paused` and `waiting-for:*` labels.

## Before You Start

✅ **Implementation Complete**
- Code changes: ✓
- Unit tests: ✓ (19/19 passing)
- Ready for integration test

## Quick Test (10 minutes)

1. **Create test issue**
   ```bash
   gh issue create --repo owner/repo \
     --title "Test #237: Resume label transition" \
     --label "process:speckit-feature"
   ```

2. **Wait for clarification gate**
   - Watch issue labels change to: `agent:paused`, `waiting-for:clarification`

3. **Provide clarification and resume**
   - Add comment with answers
   - Add `/resume` to comment

4. **Verify the fix** ⭐
   - **MUST SEE**: `agent:in-progress` label appears
   - **MUST SEE**: `agent:paused` label removed
   - **MUST SEE**: Workflow continues execution

5. **Check orchestrator logs**
   ```bash
   grep "Resume: adding agent:in-progress" logs/orchestrator.log
   ```

## Full Test (30 minutes)

See `manual-integration-test.md` for comprehensive test procedure with:
- Detailed steps
- Screenshot capture points
- Log verification
- Acceptance criteria checklist

## Expected Results

### ✅ PASS Criteria
- Label transition: `agent:paused` → `agent:in-progress`
- Label visible during active execution
- Log message: "Resume: adding agent:in-progress label"
- Clean completion (no orphaned labels)

### ❌ FAIL Criteria
- No agent status label after resume
- `agent:paused` persists after resume
- Orchestrator errors during label operations

## Troubleshooting

**Issue doesn't get `agent:in-progress`**
- Check orchestrator logs for errors
- Verify GitHub webhooks are working
- Confirm label exists in repository

**Workflow doesn't hit a gate**
- Create a more complex issue that requires clarification
- Check workflow configuration

**Can't trigger resume**
- Ensure comment includes `/resume`
- Check smee webhook is forwarding events

## Files Reference

| File | Purpose |
|------|---------|
| `manual-integration-test.md` | Full test procedure (30 min) |
| `T005-manual-test-summary.md` | Test overview and context |
| `verify-implementation.sh` | Pre-test code verification |
| `README-MANUAL-TEST.md` | This quick start guide |

## Questions?

- **Can I skip this?** No - validates core user story
- **Can I automate this?** Not easily - requires live GitHub
- **How long?** 10 min quick test, 30 min full test
- **What if it fails?** Document in manual-integration-test.md, create bug report

## Ready to Test?

1. ✓ Start orchestrator: `cd packages/orchestrator && pnpm dev`
2. ✓ Open `manual-integration-test.md`
3. ✓ Create test issue
4. ✓ Follow the steps
5. ✓ Mark T005 complete when passing

---

**Status**: Ready for manual testing
**Implementation**: ✓ Complete
**Unit Tests**: ✓ Passing (19/19)
**Next**: Run manual test, then proceed to T006
