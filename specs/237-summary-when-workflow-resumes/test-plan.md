# Test Plan: agent:in-progress Label on Resume

**Feature**: 237-summary-when-workflow-resumes
**Date**: 2026-02-24
**Test Level**: Unit + Integration

## Test Strategy

### Test Pyramid
```
    ┌─────────────────┐
    │   Integration   │  ← 1 manual test (5 minutes)
    │   (E2E flow)    │
    ├─────────────────┤
    │   Unit Tests    │  ← 2 test updates (automated)
    │ (label-manager) │
    └─────────────────┘
```

**Focus**: Unit tests verify label operations; integration test validates end-to-end workflow.

---

## Unit Tests

**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`

### Test 1: Update Existing Test — Label Addition with Stale Labels

**Test Name**: `onResumeStart > removes waiting-for:* and agent:paused labels when present`
**Location**: Lines 149-167
**Type**: Update existing test

#### Current Test Code
```typescript
it('removes waiting-for:* and agent:paused labels when present', async () => {
  const lm = createLabelManager();
  mockGithub.getIssue.mockResolvedValue({
    labels: [
      { name: 'waiting-for:clarification' },
      { name: 'agent:paused' },
      { name: 'workflow:speckit-feature' },
      { name: 'completed:specify' },
    ],
  });

  await lm.onResumeStart();

  expect(mockGithub.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
  expect(mockGithub.removeLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
    'waiting-for:clarification',
    'agent:paused',
  ]);
  // ← ADD NEW ASSERTION HERE
});
```

#### New Assertion to Add (After Line 166)
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

#### Test Coverage
- ✅ Verifies `getIssue` called to fetch current labels
- ✅ Verifies `removeLabels` called with correct stale labels
- ✅ **NEW**: Verifies `addLabels` called with `['agent:in-progress']`

#### Expected Outcome
```
✓ onResumeStart > removes waiting-for:* and agent:paused labels when present
```

---

### Test 2: Update Existing Test — Label Addition Without Stale Labels

**Test Name**: `onResumeStart > does not call removeLabels when no stale labels exist`
**Location**: Lines 169-183
**Type**: Update existing test

#### Current Test Code
```typescript
it('does not call removeLabels when no stale labels exist', async () => {
  const lm = createLabelManager();
  mockGithub.getIssue.mockResolvedValue({
    labels: [
      { name: 'workflow:speckit-feature' },
      { name: 'completed:specify' },
      { name: 'agent:in-progress' },  // Already present!
    ],
  });

  await lm.onResumeStart();

  expect(mockGithub.getIssue).toHaveBeenCalledWith('owner', 'repo', 42);
  expect(mockGithub.removeLabels).not.toHaveBeenCalled();
  // ← ADD NEW ASSERTION HERE
});
```

#### New Assertion to Add (After Line 182)
```typescript
expect(mockGithub.addLabels).toHaveBeenCalledWith('owner', 'repo', 42, [
  'agent:in-progress',
]);
```

#### Test Coverage
- ✅ Verifies `getIssue` called to fetch current labels
- ✅ Verifies `removeLabels` NOT called (no stale labels)
- ✅ **NEW**: Verifies `addLabels` STILL called (unconditional addition)

#### Expected Outcome
```
✓ onResumeStart > does not call removeLabels when no stale labels exist
```

**Why this test matters**: Handles edge case where labels were manually cleaned up before resume. The `agent:in-progress` label should still be added to reflect active state.

---

### Test 3: Existing Retry Test (No Changes)

**Test Name**: `retry on API failure > succeeds on second attempt after first addLabels call throws`
**Location**: Lines 293-308
**Type**: Existing test (verifies retry logic)

#### What This Test Verifies
```typescript
mockGithub.addLabels
  .mockRejectedValueOnce(new Error('GitHub API 503'))
  .mockResolvedValueOnce(undefined);

await lm.onPhaseComplete('plan');

expect(mockGithub.addLabels).toHaveBeenCalledTimes(2);
expect(mockGithub.removeLabels).toHaveBeenCalledTimes(2);  // ← Both retry!
```

**Implication for our fix**: When `addLabels` fails in `onResumeStart()`, the entire `retryWithBackoff()` block (including `removeLabels()`) will retry. This test validates that behavior already works.

**Action**: No changes needed. Test already covers retry behavior.

---

## Unit Test Execution

### Command
```bash
cd /workspaces/generacy/packages/orchestrator
pnpm test -- label-manager.test.ts
```

### Expected Output
```
✓ packages/orchestrator/src/worker/__tests__/label-manager.test.ts (20 tests)
  ✓ LabelManager (20)
    ✓ onPhaseStart (4)
    ✓ onPhaseComplete (1)
    ✓ onGateHit (1)
    ✓ onError (1)
    ✓ onWorkflowComplete (1)
    ✓ onResumeStart (2)  ← Our updated tests
      ✓ removes waiting-for:* and agent:paused labels when present
      ✓ does not call removeLabels when no stale labels exist
    ✓ ensureCleanup (7)
    ✓ retry on API failure (3)

Test Files  1 passed (1)
     Tests  20 passed (20)
```

### Failure Scenarios

#### Scenario 1: `addLabels` Not Called
```
AssertionError: expected "addLabels" to be called with arguments:
  ['owner', 'repo', 42, ['agent:in-progress']]
```

**Cause**: Implementation missing `addLabels()` call in `onResumeStart()`
**Fix**: Add the 4 lines per plan.md

#### Scenario 2: Wrong Label Added
```
AssertionError: expected ["agent:active"] to equal ["agent:in-progress"]
```

**Cause**: Typo in label name
**Fix**: Correct to `'agent:in-progress'` (matches constant used elsewhere)

---

## Integration Test

**Type**: Manual end-to-end test
**Duration**: ~5 minutes
**Prerequisites**: Development stack running (Firebase emulators)

### Test Environment Setup

1. **Start development stack**:
   ```bash
   cd /workspaces/tetrad-development
   ./scripts/stack start
   source ./scripts/stack-env.sh
   ```

2. **Start orchestrator**:
   ```bash
   cd /workspaces/generacy/packages/orchestrator
   pnpm dev
   ```

3. **Have GitHub CLI authenticated**:
   ```bash
   gh auth status
   ```

### Test Case 1: Resume After Clarification Gate

**Objective**: Verify `agent:in-progress` label appears during resume flow

#### Steps

1. **Create test issue**:
   ```bash
   gh issue create \
     --repo generacy-ai/generacy \
     --title "TEST: Resume label verification" \
     --body "This is a test issue to verify feature 237" \
     --label "process:speckit-feature"
   ```

   **Note issue number** (e.g., #999)

2. **Wait for clarification gate** (~30 seconds):
   ```bash
   gh issue view 999 --json labels --jq '.labels[].name'
   ```

   **Expected labels**:
   ```
   workflow:speckit-feature
   completed:specify
   waiting-for:clarification
   agent:paused
   ```

   ✅ **Checkpoint 1**: `agent:paused` present (workflow correctly paused)

3. **Provide clarification answers**:
   ```bash
   gh issue comment 999 --body "
   /continue

   Clarification answers:
   - Purpose: Test feature 237
   - Scope: Verify resume label addition
   "
   ```

4. **Immediately check labels** (within 5 seconds):
   ```bash
   watch -n 1 "gh issue view 999 --json labels --jq '.labels[].name'"
   ```

   **Expected labels transition**:
   ```
   # Initial (after comment)
   workflow:speckit-feature
   completed:specify
   waiting-for:clarification
   agent:paused

   # After onResumeStart() (~2 seconds)
   workflow:speckit-feature
   completed:specify
   agent:in-progress  ← FIX VERIFIED!

   # During plan phase
   workflow:speckit-feature
   completed:specify
   completed:clarify
   phase:plan
   agent:in-progress  ← Still present
   ```

   ✅ **Checkpoint 2**: `agent:in-progress` appears after resume
   ✅ **Checkpoint 3**: `agent:paused` and `waiting-for:clarification` removed

5. **Wait for workflow completion** (~2 minutes):
   ```bash
   gh issue view 999 --json labels --jq '.labels[].name'
   ```

   **Expected labels**:
   ```
   workflow:speckit-feature
   completed:specify
   completed:clarify
   completed:plan
   completed:implement
   completed:validate
   ```

   ✅ **Checkpoint 4**: `agent:in-progress` removed on completion

#### Success Criteria

- ✅ `agent:paused` removed after resume
- ✅ `agent:in-progress` added after resume
- ✅ `agent:in-progress` present during plan/implement phases
- ✅ `agent:in-progress` removed on completion
- ✅ No orphaned labels

#### Failure Scenarios

**Scenario 1**: `agent:in-progress` never appears
- **Symptom**: Labels show `phase:plan` but no `agent:in-progress`
- **Cause**: `addLabels()` not called in `onResumeStart()`
- **Fix**: Verify implementation per plan.md

**Scenario 2**: Both `agent:paused` and `agent:in-progress` present
- **Symptom**: Labels show both statuses simultaneously
- **Cause**: `removeLabels()` failed but `addLabels()` succeeded
- **Fix**: Check orchestrator logs for GitHub API errors

**Scenario 3**: `agent:in-progress` remains after completion
- **Symptom**: Labels show `completed:*` and `agent:in-progress`
- **Cause**: `onWorkflowComplete()` not called (separate bug)
- **Fix**: Out of scope for this feature

---

### Test Case 2: Process Event (Regression Check)

**Objective**: Verify process events still work correctly (no regression)

#### Steps

1. **Create test issue**:
   ```bash
   gh issue create \
     --repo generacy-ai/generacy \
     --title "TEST: Process event regression check" \
     --body "Verify process events unaffected by resume fix" \
     --label "process:speckit-feature"
   ```

   **Note issue number** (e.g., #1000)

2. **Immediately check labels** (within 5 seconds):
   ```bash
   gh issue view 1000 --json labels --jq '.labels[].name'
   ```

   **Expected labels**:
   ```
   workflow:speckit-feature
   agent:in-progress  ← Still added by monitor service
   phase:specify
   ```

   ✅ **Checkpoint 1**: `agent:in-progress` added immediately (no regression)

3. **Let workflow run to completion** (or cancel after verify):
   ```bash
   gh issue comment 1000 --body "/cancel"
   ```

#### Success Criteria

- ✅ `agent:in-progress` added immediately after trigger
- ✅ No change in process event behavior

---

## Test Checklist

### Pre-Implementation
- [ ] Review existing unit tests (understand current behavior)
- [ ] Review label-manager.ts implementation (understand current flow)

### During Implementation
- [ ] Update test 1: Add `addLabels` assertion (line ~166)
- [ ] Update test 2: Add `addLabels` assertion (line ~182)
- [ ] Run unit tests: `pnpm test -- label-manager.test.ts`
- [ ] Verify all tests pass

### Post-Implementation
- [ ] Integration test: Create issue with process trigger
- [ ] Integration test: Wait for clarification gate
- [ ] Integration test: Provide clarification
- [ ] Integration test: Verify `agent:in-progress` appears
- [ ] Integration test: Verify label removed on completion
- [ ] Regression test: Verify process events still work

### Before PR
- [ ] Run full orchestrator test suite: `pnpm test`
- [ ] Check for test flakiness (run tests 3 times)
- [ ] Review test coverage report (optional)

### After Deployment
- [ ] Monitor production for orphaned `agent:in-progress` labels
- [ ] Verify fix on real issue (e.g., issue #235 or similar)

---

## Test Data

### Mock Data for Unit Tests

**Scenario: Gate hit with clarification needed**
```typescript
{
  labels: [
    { name: 'waiting-for:clarification' },
    { name: 'agent:paused' },
    { name: 'workflow:speckit-feature' },
    { name: 'completed:specify' },
  ]
}
```

**Scenario: Resume without stale labels (edge case)**
```typescript
{
  labels: [
    { name: 'workflow:speckit-feature' },
    { name: 'completed:specify' },
    { name: 'agent:in-progress' },  // Already present
  ]
}
```

**Scenario: Multiple gates (tasks-review)**
```typescript
{
  labels: [
    { name: 'waiting-for:tasks-review' },
    { name: 'agent:paused' },
    { name: 'workflow:speckit-epic' },
    { name: 'completed:specify' },
    { name: 'completed:clarify' },
    { name: 'completed:plan' },
    { name: 'completed:tasks' },
  ]
}
```

---

## Debugging Tips

### Unit Test Failures

**Check mock call history**:
```typescript
console.log(mockGithub.addLabels.mock.calls);
```

**Verify mock setup**:
```typescript
expect(mockGithub.addLabels).toHaveBeenCalled();
console.log('Call count:', mockGithub.addLabels.mock.calls.length);
console.log('Arguments:', mockGithub.addLabels.mock.calls[0]);
```

### Integration Test Issues

**Check orchestrator logs**:
```bash
cd /workspaces/generacy/packages/orchestrator
tail -f logs/orchestrator.log | grep -i "resume"
```

**Check GitHub API rate limits**:
```bash
gh api rate_limit
```

**Manually inspect issue state**:
```bash
gh issue view 999 --json labels,comments,state
```

---

## Test Artifacts

**Location**: `/workspaces/generacy/specs/237-summary-when-workflow-resumes/`

- `test-plan.md` — This document
- `plan.md` — Implementation plan with test execution steps
- `state-diagram.md` — Visual reference for expected label states

**Test Reports** (generated):
- `packages/orchestrator/coverage/` — Coverage report (optional)
- CI/CD pipeline results — Automated test runs

---

*Test plan created by Claude Code on 2026-02-24*
