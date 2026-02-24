# Manual Integration Test Guide: agent:in-progress on Resume

**Feature**: #237 - Add agent:in-progress Label on Workflow Resume
**Date**: 2026-02-24
**Tester**: _____________

## Prerequisites

- [ ] Development stack is running (`/workspaces/tetrad-development/scripts/stack start`)
- [ ] Orchestrator service is running (`cd packages/orchestrator && pnpm dev`)
- [ ] GitHub webhooks are configured and pointing to your local environment
- [ ] You have access to a test repository with workflow labels configured
- [ ] `gh` CLI is authenticated and working

## Test Scenario

This test validates that when a workflow resumes after hitting a gate (e.g., clarification), the issue correctly transitions from `agent:paused` to `agent:in-progress`.

### Step 1: Create Test Issue

```bash
# Create a test issue in your repository
gh issue create \
  --repo <owner>/<repo> \
  --title "Test: Workflow Resume Label Transition #237" \
  --body "Testing that agent:in-progress is added when workflow resumes after gate" \
  --label "process:speckit-feature"
```

**Expected Result**:
- New issue created with issue number (e.g., #123)
- Workflow should start automatically (watch orchestrator logs)

Record issue number: ______________

### Step 2: Monitor Initial Workflow Execution

Watch the orchestrator logs:
```bash
cd packages/orchestrator
pnpm dev
```

**Expected Behavior**:
- Issue should get `agent:in-progress` label immediately
- Workflow progresses through phases: specify → clarify → plan → implement
- Logs show phase transitions

**Actual Observations**:
```
Initial labels: _______________________________________________
Phase transitions: _____________________________________________
```

### Step 3: Wait for Clarification Gate

The workflow will likely hit a clarification gate during the specify or clarify phase.

**Expected Behavior**:
- Workflow pauses at gate
- Issue gets labels: `waiting-for:clarification`, `agent:paused`
- `agent:in-progress` is removed
- Orchestrator logs show: "Gate hit: clarification"

**Actual Observations**:
```
Gate labels added: _____________________________________________
Gate timestamp: ________________________________________________
Orchestrator log message: ______________________________________
```

**GitHub Issue Screenshot** (optional):
- Take screenshot showing labels at this point
- Expected: `waiting-for:clarification`, `agent:paused`, phase label

### Step 4: Provide Clarification Answers

Add a comment to the issue with clarification answers:

```markdown
## Clarification Answers

1. **Question from agent**: [copy question here]
   **Answer**: [your answer]

2. **Question from agent**: [copy question here]
   **Answer**: [your answer]

[Continue for all questions...]

/resume
```

**Expected Result**:
- Comment triggers resume event
- Orchestrator picks up the resume command

### Step 5: Verify Label Transition on Resume ⭐ **CRITICAL TEST POINT**

**This is the core behavior being tested.**

Watch the issue labels immediately after posting the clarification answers:

**Expected Behavior** (with fix #237):
1. `waiting-for:clarification` label is **removed**
2. `agent:paused` label is **removed**
3. `agent:in-progress` label is **added** ← **This is the fix!**
4. Workflow continues with plan/implement phases
5. Orchestrator logs show: `"Resume: adding agent:in-progress label"`

**Actual Observations**:
```
Labels after resume:
  - waiting-for:clarification: [removed/still present] ___________
  - agent:paused: [removed/still present] _______________________
  - agent:in-progress: [added/missing] __________________________ ← KEY!

Orchestrator logs:
  _____________________________________________________________
  _____________________________________________________________
  _____________________________________________________________

Timestamp of label change: _____________________________________
```

**GitHub Issue Screenshot** (required):
- Take screenshot showing `agent:in-progress` label present during execution
- This proves the fix is working

### Step 6: Monitor Through Completion

Let the workflow complete:

**Expected Behavior**:
- Workflow proceeds through remaining phases (plan → implement → review)
- Phase labels are added/removed correctly
- On completion, `agent:in-progress` is **removed**
- Final labels include `agent:completed` or `agent:error` (depending on outcome)

**Actual Observations**:
```
Final phase executed: __________________________________________
Completion labels: _____________________________________________
Workflow duration: _____________________________________________
```

### Step 7: Verify Logs

Check orchestrator logs for the resume event:

```bash
# Search for resume-related log entries
grep -A 5 "Resume: adding agent:in-progress" orchestrator.log
```

**Expected Log Entries**:
```json
{
  "level": "info",
  "issue": 123,
  "msg": "Resume: removing waiting-for and agent:paused labels",
  "labels": ["waiting-for:clarification", "agent:paused"]
}
{
  "level": "info",
  "issue": 123,
  "msg": "Resume: adding agent:in-progress label"
}
```

**Actual Log Entries**:
```
_________________________________________________________________
_________________________________________________________________
_________________________________________________________________
```

## Test Results

### Acceptance Criteria Checklist

- [ ] **AC1**: `agent:paused` → `agent:in-progress` transition occurs on resume
- [ ] **AC2**: `agent:in-progress` persists during active phase execution
- [ ] **AC3**: Label is visible in GitHub issue UI during execution
- [ ] **AC4**: No orphaned `agent:in-progress` labels after completion
- [ ] **AC5**: Logs show "Resume: adding agent:in-progress label" message
- [ ] **AC6**: Label transition happens before phase execution starts
- [ ] **AC7**: Workflow completes successfully with correct final labels

### Edge Cases Tested

- [ ] Resume when no stale labels exist (manual label removal before resume)
- [ ] Multiple resume events (hit gate twice)
- [ ] Resume with different gate types (clarification, approval, etc.)

## Issues Found

Document any bugs or unexpected behavior:

```
Issue #: ___________
Description: _______________________________________________________
Severity: [Critical/High/Medium/Low]
Workaround: ________________________________________________________
```

## Test Outcome

**Overall Result**: [ PASS / FAIL / BLOCKED ]

**Tester Signature**: ____________________
**Date Completed**: ____________________
**Orchestrator Version**: ____________________

## Notes

Additional observations or comments:

```
___________________________________________________________________
___________________________________________________________________
___________________________________________________________________
```

---

## Cleanup

After testing, close the test issue:

```bash
gh issue close <issue-number> --comment "Test complete: #237 verification passed"
```
