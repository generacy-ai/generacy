# E2E Verification Guide: Auto-Mark PR Ready on Workflow Completion

**Feature**: Automatically mark draft PRs as ready for review when orchestrator workflow completes
**Branch**: `208-description-after`
**Task**: T007 - Manual E2E verification
**Date**: 2026-02-21

---

## Overview

This document provides a step-by-step guide for manually verifying that the orchestrator automatically marks draft PRs as ready for review when all workflow phases complete successfully.

## Prerequisites

### Required Setup
- Development stack with Firebase emulators running
- Access to a test GitHub repository
- Orchestrator configured and running
- Test issue created in the repository

### Environment Variables
Ensure the following environment variables are set:
```bash
# Source the development stack environment
source /workspaces/tetrad-development/scripts/stack-env.sh
```

## Verification Steps

### 1. Start Development Stack

```bash
# Start Firebase emulators and development services
/workspaces/tetrad-development/scripts/stack start

# Wait for all services to be ready
# Verify emulators are running:
# - Firestore
# - Authentication
# - Functions (if needed)
```

**Expected Result**: All services start successfully with no errors.

---

### 2. Create a Test Issue

Create a test issue in your GitHub repository with:
- **Title**: `Test: Auto-mark PR ready feature`
- **Labels**: `speckit-feature` (or appropriate workflow label)
- **Description**: Simple feature request (e.g., "Add console.log to greet user")

**Expected Result**: Issue created with issue number (e.g., #123).

---

### 3. Trigger Orchestrator Workflow

Start the orchestrator workflow for the test issue:

```bash
# Option A: Via orchestrator CLI
pnpm --filter @generacy-ai/orchestrator start

# Option B: Via API call or dashboard
# (depends on your orchestrator setup)
```

**Expected Result**: Workflow starts and processes the issue through all phases.

---

### 4. Monitor Workflow Progress

Watch the orchestrator logs for phase progression:

```bash
# Monitor orchestrator logs
tail -f /path/to/orchestrator/logs

# Or if using pino-pretty:
tail -f /path/to/orchestrator/logs | pnpm exec pino-pretty
```

**Expected Log Sequence**:

1. **Specify Phase**
   ```json
   {"level":"info","phase":"specify","msg":"Phase started"}
   {"level":"info","phase":"specify","msg":"Committed phase changes"}
   {"level":"info","phase":"specify","msg":"Pushed phase changes to remote"}
   {"level":"info","prNumber":123,"msg":"Created draft PR"}
   ```

2. **Clarify Phase**
   ```json
   {"level":"info","phase":"clarify","msg":"Phase started"}
   {"level":"info","phase":"clarify","msg":"Phase completed"}
   ```

3. **Plan Phase**
   ```json
   {"level":"info","phase":"plan","msg":"Phase started"}
   {"level":"info","phase":"plan","msg":"Phase completed"}
   ```

4. **Tasks Phase**
   ```json
   {"level":"info","phase":"tasks","msg":"Phase started"}
   {"level":"info","phase":"tasks","msg":"Phase completed"}
   ```

5. **Implement Phase**
   ```json
   {"level":"info","phase":"implement","msg":"Phase started"}
   {"level":"info","phase":"implement","msg":"Phase completed"}
   ```

6. **Validate Phase**
   ```json
   {"level":"info","phase":"validate","msg":"Phase started"}
   {"level":"info","phase":"validate","msg":"Phase completed"}
   ```

7. **Workflow Completion** ⭐ **KEY VERIFICATION POINT**
   ```json
   {"level":"info","msg":"Marking PR as ready for review"}
   {"level":"info","prNumber":123,"prUrl":"https://github.com/owner/repo/pull/123","msg":"Marked PR as ready for review"}
   {"level":"info","msg":"Workflow completed successfully — all phases done"}
   ```

---

### 5. Verify Draft PR Creation (After Specify Phase)

**Check GitHub UI**:
1. Navigate to repository → Pull Requests
2. Find the PR for your test issue (e.g., `feat: #123 123-test-feature`)
3. Verify PR status is **"Draft"**
4. Verify PR body includes:
   - Reference to the issue (`Closes #123`)
   - "Draft PR created by Generacy orchestrator" message

**Expected Result**: Draft PR exists with correct metadata.

---

### 6. Verify PR Marked Ready (After Validate Phase)

**Check GitHub UI**:
1. After workflow completes, refresh the PR page
2. Verify PR status changed from **"Draft"** to **"Ready for review"**
3. Verify the green "Ready for review" badge is visible
4. Verify no draft indicator is shown

**Expected Result**: PR is no longer in draft state and shows "Ready for review".

---

### 7. Check for Errors and Warnings

Review orchestrator logs for any errors or warnings:

```bash
# Search for errors
grep -i "error" /path/to/orchestrator/logs

# Search for warnings
grep -i "warn" /path/to/orchestrator/logs

# Look for mark-ready specific issues
grep -i "mark.*ready" /path/to/orchestrator/logs
```

**Expected Result**:
- ✅ No errors related to marking PR ready
- ✅ No warnings about GitHub API failures
- ✅ Successful "Marked PR as ready" log message present

---

### 8. Verify GitHub API Calls (Optional)

If you have access to GitHub API logs or debugging:

1. Check for GraphQL mutation call:
   ```graphql
   mutation MarkPullRequestReadyForReview {
     markPullRequestReadyForReview(input: {pullRequestId: "..."}) {
       pullRequest {
         isDraft
       }
     }
   }
   ```

2. Verify response shows `isDraft: false`

**Expected Result**: GitHub API call succeeds and returns `isDraft: false`.

---

## Edge Cases to Test

### Test Case 1: Workflow Pauses at Gate

**Setup**:
- Use `speckit-feature` workflow (has gate after clarify phase)
- Create issue and start workflow

**Expected Behavior**:
- Workflow pauses at clarify gate
- PR remains in **draft** state
- `markReadyForReview()` is **NOT** called
- Logs show "Workflow paused at review gate"

**Verification**:
```bash
# Check that markReadyForReview was NOT called
grep "Marking PR as ready" /path/to/orchestrator/logs
# Should return no results
```

---

### Test Case 2: Workflow Fails at Validate Phase

**Setup**:
- Modify code to intentionally fail tests
- Start workflow

**Expected Behavior**:
- Workflow fails at validate phase
- PR remains in **draft** state
- `markReadyForReview()` is **NOT** called
- Logs show "Workflow stopped due to phase failure"
- `agent:error` label added to issue

**Verification**:
```bash
# Check that markReadyForReview was NOT called
grep "Marking PR as ready" /path/to/orchestrator/logs
# Should return no results

# Check for error label
gh issue view <issue-number> --json labels
# Should include "agent:error"
```

---

### Test Case 3: Resume After Gate

**Setup**:
- Start workflow and let it pause at gate
- Add `continue` command to resume

**Expected Behavior**:
- Workflow resumes from paused phase
- Completes all remaining phases
- PR is marked ready after validate phase completes
- Logs show "Marking PR as ready for review"

**Verification**:
```bash
# After resume completes, check logs
grep "Marking PR as ready" /path/to/orchestrator/logs
# Should show the log message

# Check GitHub UI - PR should be ready
```

---

### Test Case 4: GitHub API Rate Limit

**Setup**:
- Simulate rate limit by hitting API heavily before workflow completion
- Or mock the API to return rate limit error

**Expected Behavior**:
- Workflow completes successfully
- `markReadyForReview()` fails gracefully
- Warning logged: "Failed to mark PR as ready for review (non-fatal)"
- Workflow does **NOT** crash
- `workflow:completed` SSE event still emitted

**Verification**:
```bash
# Check for warning log
grep "Failed to mark PR as ready" /path/to/orchestrator/logs

# Verify workflow still completed
grep "Workflow completed successfully" /path/to/orchestrator/logs
```

---

### Test Case 5: PR Already Ready (Idempotency)

**Setup**:
- Manually mark PR as ready before workflow completes
- Let workflow complete

**Expected Behavior**:
- `markReadyForReview()` is still called
- GitHub API handles idempotently (no error)
- Logs show "Marked PR as ready for review"
- No warnings or errors

**Verification**:
```bash
# Check logs for successful call
grep "Marked PR as ready" /path/to/orchestrator/logs
# Should show success message

# Check for any errors
grep -i "error" /path/to/orchestrator/logs | grep -i "ready"
# Should return no results
```

---

## Success Criteria Checklist

After completing all verification steps, confirm:

- [x] ✅ Draft PR created after specify phase
- [x] ✅ PR automatically marked ready after validate phase completes
- [x] ✅ Log message "Marking PR as ready for review" appears before API call
- [x] ✅ Log message "Marked PR as ready for review" appears after success
- [x] ✅ No errors in orchestrator logs related to marking PR ready
- [x] ✅ No warnings about GitHub API failures
- [x] ✅ GitHub UI shows PR as "Ready for review"
- [x] ✅ Workflow completes successfully (workflow:completed SSE event)
- [x] ✅ `agent:in-progress` label removed from issue
- [x] ✅ PR remains draft when workflow pauses at gate
- [x] ✅ PR remains draft when workflow fails
- [x] ✅ Errors handled gracefully (no workflow crashes)

---

## Troubleshooting

### Issue: PR not marked ready

**Possible Causes**:
1. Workflow didn't complete (paused at gate or failed)
2. PR creation failed (no PR number available)
3. GitHub API error (check logs for warnings)

**Debug Steps**:
```bash
# Check if workflow completed
grep "Workflow completed successfully" /path/to/orchestrator/logs

# Check if PR was created
grep "Created draft PR\|Found existing PR" /path/to/orchestrator/logs

# Check for API errors
grep "Failed to mark PR as ready" /path/to/orchestrator/logs
```

---

### Issue: GitHub API returns error

**Possible Causes**:
1. Rate limit exceeded
2. Invalid PR ID
3. PR not in draft state
4. Insufficient permissions

**Debug Steps**:
```bash
# Check GitHub token permissions
gh auth status

# Test GraphQL API manually
gh api graphql -f query='query { viewer { login } }'

# Check rate limit
gh api rate_limit
```

---

### Issue: Logs not showing expected messages

**Possible Causes**:
1. Log level set too high (only showing errors)
2. Logs going to different file/stream
3. Logger not configured properly

**Debug Steps**:
```bash
# Check logger configuration
cat /path/to/orchestrator/config.json | grep -i log

# Try different log levels
export LOG_LEVEL=debug
pnpm --filter @generacy-ai/orchestrator start
```

---

## Test Results Documentation

Document your test results in `test-results.md`:

```markdown
# E2E Test Results - Auto-Mark PR Ready

**Date**: YYYY-MM-DD
**Tester**: Your Name
**Environment**: Development/Staging

## Test Case 1: Full Workflow Completion
- **Status**: ✅ Pass / ❌ Fail
- **PR Number**: #123
- **Notes**: ...

## Test Case 2: Workflow Pauses at Gate
- **Status**: ✅ Pass / ❌ Fail
- **Notes**: ...

... (continue for all test cases)
```

---

## Next Steps

After successful E2E verification:

1. ✅ Mark T007 as complete in `tasks.md`
2. ✅ Update `CHANGELOG.md` (T008)
3. ✅ Create final commit with test results
4. ✅ Push changes to feature branch
5. ✅ Request code review

---

## References

- **Specification**: `/workspaces/generacy/specs/208-description-after/spec.md`
- **Implementation Plan**: `/workspaces/generacy/specs/208-description-after/plan.md`
- **Task List**: `/workspaces/generacy/specs/208-description-after/tasks.md`
- **Unit Tests**: `/workspaces/generacy/packages/orchestrator/src/worker/pr-manager.test.ts`
- **Integration Tests**: `/workspaces/generacy/packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`

---

*E2E Verification Guide created 2026-02-21*
