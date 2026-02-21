# Feature Specification: Auto-Mark PR Ready After Workflow Completion

**Branch**: `208-description-after` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

Automatically transition orchestrator-created draft PRs to "ready for review" status when all workflow phases complete successfully. Currently, PRs remain in draft state indefinitely after the validate phase finishes, requiring manual intervention to notify reviewers that work is complete.

## Problem Statement

### Current Behavior

1. Orchestrator executes phases: specify → clarify → plan → tasks → implement → validate
2. After each phase, `PrManager.commitPushAndEnsurePr()` commits changes and ensures a **draft PR** exists
3. When all phases complete successfully, `onWorkflowComplete()` only removes the `agent:in-progress` label
4. The PR remains in draft state with no notification to potential reviewers
5. Manual intervention is required to mark the PR as ready for review

### Expected Behavior

When the workflow completes successfully (all phases done):

1. The PR should automatically be marked as ready for review (removing draft status)
2. Reviewers should be notified that the work is complete and ready for their attention
3. The transition should be logged for audit purposes
4. Errors in marking ready should be handled gracefully (non-fatal)

## User Stories

### US1: Automated PR Ready Transition

**As a** repository maintainer,
**I want** the orchestrator to automatically mark PRs as ready for review when workflows complete,
**So that** reviewers are notified immediately without requiring manual intervention.

**Acceptance Criteria**:
- [x] When all phases complete successfully (`loopResult.completed === true`), the PR is marked ready
- [x] The PR number is extracted from the PR URL stored in `PrManager`
- [x] The `markPRReady()` method is called on the GitHub client
- [x] Success is logged with PR number and URL
- [x] Failures are logged as warnings but don't fail the workflow (non-fatal)
- [x] The operation occurs after `labelManager.onWorkflowComplete()` but before final logging

### US2: Graceful Error Handling

**As a** system operator,
**I want** PR ready marking failures to be handled gracefully,
**So that** workflow completion isn't blocked by GitHub API issues.

**Acceptance Criteria**:
- [x] Errors are caught and logged as warnings, not errors
- [x] Workflow continues and completes successfully even if marking ready fails
- [x] Error messages include context (PR URL, error details)
- [x] The failure doesn't affect label removal or other completion tasks

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `markReadyForReview()` method to `PrManager` class | P1 | Public async method, returns void |
| FR-002 | Extract PR number from stored PR URL | P1 | Parse from `https://github.com/{owner}/{repo}/pull/{number}` format |
| FR-003 | Call `github.markPRReady(owner, repo, prNumber)` | P1 | Use existing GitHubClient interface method (line 163) |
| FR-004 | Log success with PR number and URL | P1 | Use `info` level logging |
| FR-005 | Handle errors gracefully (try/catch) | P1 | Log as `warn`, don't throw |
| FR-006 | Handle case where no PR exists yet | P2 | Log debug message, return early |
| FR-007 | Call `markReadyForReview()` from `claude-cli-worker.ts` | P1 | In `loopResult.completed` block after line 228 |
| FR-008 | Log invocation from worker | P2 | Optional: log that we're marking PR ready |

## Technical Implementation

### File Changes

#### 1. `/workspaces/generacy/packages/orchestrator/src/worker/pr-manager.ts`

Add new public method after line 43:

```typescript
/**
 * Mark the draft PR as ready for review.
 *
 * Call this when the workflow completes successfully to notify reviewers.
 * Safe to call even if no PR exists — handles gracefully.
 */
async markReadyForReview(): Promise<void> {
  // If no PR was created, nothing to do
  if (!this.prUrl) {
    this.logger.debug('No PR to mark ready (PR was never created)');
    return;
  }

  try {
    // Extract PR number from URL: https://github.com/{owner}/{repo}/pull/{number}
    const match = this.prUrl.match(/\/pull\/(\d+)$/);
    if (!match) {
      this.logger.warn(
        { prUrl: this.prUrl },
        'Could not extract PR number from URL',
      );
      return;
    }

    const prNumber = parseInt(match[1], 10);

    // Mark the PR as ready for review
    await this.github.markPRReady(this.owner, this.repo, prNumber);

    this.logger.info(
      { prNumber, prUrl: this.prUrl },
      'Marked PR as ready for review',
    );
  } catch (error) {
    // Log but don't fail the workflow — marking ready is best-effort
    this.logger.warn(
      { prUrl: this.prUrl, error: String(error) },
      'Failed to mark PR as ready for review (non-fatal)',
    );
  }
}
```

#### 2. `/workspaces/generacy/packages/orchestrator/src/worker/claude-cli-worker.ts`

Update line 227-229 to call the new method:

```typescript
// 7. Handle completion
if (loopResult.completed) {
  await labelManager.onWorkflowComplete();
  await prManager.markReadyForReview();
  workerLogger.info('Workflow completed successfully — all phases done');
  // ... rest of completion logic
}
```

### API Surface

The `GitHubClient.markPRReady()` method is already defined in the interface:

```typescript
// packages/workflow-engine/src/actions/github/client/interface.ts:163
markPRReady(owner: string, repo: string, number: number): Promise<void>;
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PR marked ready on completion | 100% | All successful workflow completions automatically mark PR ready |
| SC-002 | No workflow failures from marking ready | 100% | Errors are handled gracefully, workflow completes |
| SC-003 | Audit trail completeness | 100% | All ready transitions are logged with PR number |
| SC-004 | Time to reviewer notification | < 10s | From workflow completion to PR ready state |

## Assumptions

- The `GitHubClient.markPRReady()` implementation already exists and functions correctly
- The PR URL format is consistent: `https://github.com/{owner}/{repo}/pull/{number}`
- A PR has been created during the workflow (after the specify phase)
- The GitHub API token has permission to update PRs
- Marking a PR ready that's already ready is idempotent (no error)

## Out of Scope

- **Reviewer assignment**: This feature only marks the PR ready; it does not assign reviewers (future enhancement)
- **Custom notification messages**: Standard GitHub notifications are used; no custom messages
- **Conditional ready marking**: PR is always marked ready on completion; no configurable conditions
- **PR body updates**: The PR description is not updated when marked ready
- **Rollback on review rejection**: If a PR is rejected, the system doesn't revert to draft
- **Review gate integration**: This feature doesn't interact with the review gate system
- **Failed workflow handling**: PRs are only marked ready on successful completion, not on failures

## Edge Cases

| Scenario | Handling |
|----------|----------|
| No PR created | `markReadyForReview()` returns early (debug log) |
| PR URL format invalid | Log warning, return early |
| GitHub API error | Catch, log warning, continue workflow |
| PR already ready | Idempotent operation (GitHub API handles) |
| Network timeout | Catch, log warning, continue workflow |
| Invalid PR number | GitHub API returns error, caught and logged |

## Testing Considerations

- **Unit test**: `PrManager.markReadyForReview()` with mocked GitHub client
- **Unit test**: URL parsing edge cases (invalid URLs, missing PR number)
- **Unit test**: Error handling (API errors don't throw)
- **Integration test**: Full workflow completion marks PR ready
- **Integration test**: No PR exists (early return)
- **Manual test**: Verify GitHub notifications are sent to watchers

## Related Files

- `/workspaces/generacy/packages/orchestrator/src/worker/pr-manager.ts` — add method
- `/workspaces/generacy/packages/orchestrator/src/worker/claude-cli-worker.ts` — call method
- `/workspaces/generacy/packages/workflow-engine/src/actions/github/client/interface.ts` — interface definition (no changes)
- `/workspaces/generacy/packages/workflow-engine/src/actions/github/client/gh-cli.ts` — implementation (verify exists)

---

*Generated by speckit*
