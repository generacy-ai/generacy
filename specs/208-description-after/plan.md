# Implementation Plan: Auto-Mark PR Ready on Workflow Completion

**Feature**: Automatically mark draft PRs as ready for review when orchestrator workflow completes
**Branch**: `208-description-after`
**Date**: 2026-02-21

---

## Summary

When the orchestrator's phase loop completes successfully (all phases done), the draft PR should be automatically marked as ready for review. This eliminates manual intervention and notifies reviewers immediately.

**Current behavior**: After all phases complete (`loopResult.completed === true`), the PR remains in draft state indefinitely.

**Target behavior**: After all phases complete, the orchestrator calls `PrManager.markReadyForReview()` to convert the draft PR to ready state via the GitHub API.

---

## Technical Context

### Language & Framework
- **Language**: TypeScript
- **Runtime**: Node.js
- **Package**: `@generacy-ai/orchestrator`

### Key Dependencies
- **`@generacy-ai/workflow-engine`**: Provides `GitHubClient` interface with `markPRReady()` method already implemented
- **`pino`**: Structured logging (via `Logger` interface)

### Existing Infrastructure
The `GitHubClient` interface (line 163 of `interface.ts`) already includes:
```typescript
markPRReady(owner: string, repo: string, number: number): Promise<void>;
```

This is implemented in `gh-cli.ts` and calls the GitHub GraphQL `markPullRequestReadyForReview` mutation. The mutation is idempotent — calling it on a non-draft PR is a no-op.

---

## Architecture Overview

### Component Interaction

```
claude-cli-worker.ts (line 227)
  ↓ loopResult.completed === true
  ├─→ labelManager.onWorkflowComplete()      [existing]
  ├─→ prManager.markReadyForReview()          [NEW]
  └─→ sseEmitter (workflow:completed)         [existing]

pr-manager.ts
  ├─ commitPushAndEnsurePr()                  [existing]
  │   ├─→ commitAndPush()
  │   └─→ ensureDraftPr()  [caches prUrl, prNumber internally]
  └─ markReadyForReview()                     [NEW]
      ├─→ github.getCurrentBranch()
      ├─→ github.findPRForBranch()  [returns PullRequest with .number]
      └─→ github.markPRReady(owner, repo, prNumber)
```

### Key Design Decisions

#### 1. Single Attempt, No Retries (from Q3)
**Decision**: Use single-attempt, log-and-continue pattern
**Rationale**: Matches existing `PrManager` conventions (`commitAndPush`, `ensureDraftPr`). Unlike `LabelManager` (which retries because labels control workflow gates), marking ready is a final notification — if it fails, humans can click the button manually.

#### 2. Trust GitHub API Idempotency (from Q2)
**Decision**: Always call `markPRReady()` without checking draft state first
**Rationale**: Consistent with `ensureDraftPr()` pattern. The GraphQL mutation is a no-op on non-draft PRs. Checking first adds complexity and a race window for no practical benefit.

#### 3. Error Serialization with `String(error)` (from Q5)
**Decision**: Use `String(error)` in logs
**Rationale**: Every error log in `PrManager` and `LabelManager` uses `{ error: String(error) }`. Stay consistent with established conventions.

#### 4. No Timing Instrumentation (from Q6)
**Decision**: No duration metrics for this operation
**Rationale**: Single GitHub API call will be <10s barring network issues. If latency becomes a concern, add it across all GitHub operations as a cross-cutting concern, not scoped to one method.

#### 5. No PR Body Updates (from Q7)
**Decision**: Leave PR body unchanged (keep "Draft PR" footer text)
**Rationale**: Explicitly listed as out-of-scope in spec. GitHub UI clearly shows draft vs ready state. Updating body adds a second API call and another failure mode.

#### 6. Always Mark Ready (from Q8)
**Decision**: No configuration flag or label override
**Rationale**: `PrManager` is fully parameterized by constructor args today. Adding config for hypothetical "keep-draft" use cases adds complexity before there's a real need. YAGNI.

---

## Implementation Phases

### Phase 1: Add `markReadyForReview()` to `PrManager`
**File**: `packages/orchestrator/src/worker/pr-manager.ts`

**Location**: After `ensureDraftPr()` (after line 140)

**Implementation**:
```typescript
/**
 * Mark the draft PR as ready for review.
 *
 * Finds the PR for the current branch and marks it ready via GitHub API.
 * Safe to call even if the PR is already ready (GitHub API is idempotent).
 *
 * This is best-effort — errors are logged as warnings and do not fail the workflow.
 */
async markReadyForReview(): Promise<void> {
  try {
    const branch = await this.github.getCurrentBranch();

    // Find the PR for this branch
    const pr = await this.github.findPRForBranch(this.owner, this.repo, branch);
    if (!pr) {
      this.logger.warn(
        { branch },
        'No PR found for branch — cannot mark ready',
      );
      return;
    }

    // Mark the PR as ready (idempotent if already ready)
    await this.github.markPRReady(this.owner, this.repo, pr.number);

    this.logger.info(
      { prNumber: pr.number, prUrl: this.prUrl },
      'Marked PR as ready for review',
    );
  } catch (error) {
    // Log but don't fail the workflow — marking ready is best-effort
    this.logger.warn(
      { error: String(error) },
      'Failed to mark PR ready (non-fatal)',
    );
  }
}
```

**Key Points**:
- Uses cached `this.prUrl` if available (for logging), but doesn't depend on it
- Calls `findPRForBranch()` to get fresh PR data with `.number` property
- Handles "no PR found" gracefully (log warning, return early)
- Catches all errors and logs as `warn` (matches `commitAndPush` pattern)
- Never re-throws (non-fatal best-effort operation)

**Test Coverage**:
- Unit test: verify method calls `github.markPRReady()` with correct args
- Unit test: verify "no PR found" case logs warning and returns gracefully
- Unit test: verify API errors are caught, logged as warnings, and don't throw

---

### Phase 2: Call `markReadyForReview()` from Worker
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

**Location**: Line 227-229 (`loopResult.completed` branch)

**Before**:
```typescript
if (loopResult.completed) {
  await labelManager.onWorkflowComplete();
  workerLogger.info('Workflow completed successfully — all phases done');
  // ...
}
```

**After**:
```typescript
if (loopResult.completed) {
  await labelManager.onWorkflowComplete();
  workerLogger.info('Workflow completed successfully — all phases done');
  workerLogger.info('Marking PR as ready for review');
  await prManager.markReadyForReview();
  // ...
}
```

**Key Points**:
- Add info-level log before the call (from Q4) for traceability
- Call `markReadyForReview()` after label cleanup, before SSE emission
- Sequential execution (not parallel) — wait for label cleanup before marking ready
- No error handling needed here (errors caught and logged within `markReadyForReview`)

**Test Coverage**:
- Integration test: verify `markReadyForReview()` is called when `loopResult.completed === true`
- Integration test: verify NOT called when `loopResult.gateHit === true`
- Integration test: verify NOT called when phase fails

---

## API Contracts

No new API endpoints. Uses existing GitHub GraphQL mutation via `GitHubClient.markPRReady()`.

**GitHub GraphQL Mutation** (already implemented in `workflow-engine`):
```graphql
mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      id
      isDraft
    }
  }
}
```

**Behavior**:
- Converts draft PR to ready state
- Idempotent: calling on non-draft PR is a no-op
- No error if PR is already ready

---

## Data Models

No new data models. Uses existing types:

**`PullRequest`** (from `workflow-engine/src/types/github.ts`):
```typescript
interface PullRequest {
  number: number;       // ← Used to call markPRReady()
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;       // ← Not checked (trust API idempotency)
  head: BranchRef;
  base: BranchRef;
  labels: Label[];
  created_at: string;
  updated_at: string;
}
```

---

## Risk Mitigation

### Risk 1: PR Not Found
**Scenario**: `findPRForBranch()` returns `null` (branch has no PR)
**Likelihood**: Low (PR created in specify phase, method called after validate)
**Impact**: Medium (PR not marked ready, manual intervention needed)
**Mitigation**:
- Log warning with branch name for debugging
- Return early (graceful degradation)
- User can manually click "Ready for review" in GitHub UI

### Risk 2: GitHub API Failure
**Scenario**: `markPRReady()` throws (network error, rate limit, permissions)
**Likelihood**: Low (single API call, same auth as PR creation)
**Impact**: Low (PR not marked ready, manual intervention needed)
**Mitigation**:
- Catch all errors in `markReadyForReview()`
- Log as `warn` with error details
- Don't re-throw (workflow completes successfully)
- User can manually click "Ready for review"

### Risk 3: Partial Workflow Resume
**Scenario**: User manually marks PR ready, then workflow resumes and completes
**Likelihood**: Low (uncommon workflow pattern)
**Impact**: None (GitHub API is idempotent)
**Mitigation**:
- Trust GitHub API idempotency (no pre-check needed)
- Calling `markPRReady()` on already-ready PR is a no-op

### Risk 4: Race Condition (Multiple Workers)
**Scenario**: Two workers complete workflow simultaneously, both try to mark ready
**Likelihood**: Very low (single-threaded worker pool, issue locked during processing)
**Impact**: None (GitHub API is idempotent)
**Mitigation**:
- Trust GitHub API idempotency
- Both calls succeed (second is no-op)

### Risk 5: Log Noise
**Scenario**: New info log adds noise to production logs
**Likelihood**: Low (one-time log per workflow completion)
**Impact**: Very low (single line per completed workflow)
**Mitigation**:
- Use info level (consistent with other workflow state transitions)
- Message is concise and actionable
- If noise becomes an issue, can demote to debug level later

---

## Testing Strategy

### Unit Tests

**`pr-manager.test.ts`**:
1. **Success path**: Verify `markReadyForReview()` calls GitHub API with correct args
   - Mock `getCurrentBranch()` → `"123-feature"`
   - Mock `findPRForBranch()` → `{ number: 42, draft: true, ... }`
   - Mock `markPRReady(owner, repo, 42)` → `void`
   - Assert `markPRReady` called with `(owner, repo, 42)`
   - Assert info log emitted with `prNumber: 42`

2. **No PR found**: Verify warning logged and method returns gracefully
   - Mock `findPRForBranch()` → `null`
   - Assert `markPRReady` NOT called
   - Assert warning log emitted with branch name

3. **API error**: Verify error caught and logged as warning
   - Mock `markPRReady()` → throws `Error("API rate limit")`
   - Assert warning log emitted with error string
   - Assert method doesn't throw (returns normally)

**`claude-cli-worker.test.ts`**:
1. **Workflow completion**: Verify `markReadyForReview()` called on completion
   - Mock `phaseLoop.executeLoop()` → `{ completed: true, ... }`
   - Assert `prManager.markReadyForReview()` called
   - Assert info log "Marking PR as ready" emitted

2. **Gate hit**: Verify `markReadyForReview()` NOT called at gates
   - Mock `phaseLoop.executeLoop()` → `{ gateHit: true, ... }`
   - Assert `prManager.markReadyForReview()` NOT called

3. **Phase failure**: Verify `markReadyForReview()` NOT called on failure
   - Mock `phaseLoop.executeLoop()` → `{ completed: false, gateHit: false, ... }`
   - Assert `prManager.markReadyForReview()` NOT called

### Integration Tests

**Manual verification** (or add to orchestrator E2E suite):
1. Run full workflow (specify → clarify → plan → tasks → implement → validate)
2. Verify draft PR created after specify phase
3. Verify PR marked ready after validate phase completes
4. Verify GitHub sends reviewer notification emails
5. Check logs for "Marking PR as ready" and "Marked PR as ready" messages

### Edge Case Tests

1. **Resume after gate**: Workflow pauses at gate, resumes, completes → PR marked ready
2. **PR already ready**: Manually mark PR ready, then complete workflow → no error
3. **Deleted PR**: Delete PR, then complete workflow → warning logged, no crash

---

## Success Metrics

From spec Success Criteria:

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PRs marked ready after validation | 100% | Monitor logs for "Marked PR as ready" vs "Workflow completed" |
| SC-002 | Failed mark-ready attempts | <5% | Monitor logs for "Failed to mark PR ready" warnings |
| SC-003 | Workflow failures due to mark-ready | 0% | Verify all errors are caught (no uncaught exceptions) |
| SC-004 | Time to reviewer notification | <10s | Trust GitHub API latency (no instrumentation needed) |

---

## Out of Scope

Explicitly NOT included in this implementation (per spec and clarifications):

1. **Reviewer assignment**: No automatic reviewer requests (can be added later)
2. **PR body updates**: Draft footer text not changed (cosmetic, adds complexity)
3. **Conditional marking**: Always mark ready on completion (no config flags)
4. **Retry logic**: Single attempt only (matches PrManager pattern)
5. **Timing metrics**: No duration instrumentation (YAGNI)
6. **Pre-checks**: No draft state verification before marking (trust API idempotency)

---

## Rollout Plan

### Phase 1: Implementation & Testing
1. Add `markReadyForReview()` to `PrManager`
2. Add unit tests for `PrManager.markReadyForReview()`
3. Update `claude-cli-worker.ts` to call new method
4. Add unit tests for worker integration

### Phase 2: Deployment
1. Merge to `develop` branch
2. Deploy to staging environment
3. Run manual E2E test (full workflow with draft PR)
4. Monitor logs for success/failure messages

### Phase 3: Monitoring
1. Track "Marked PR as ready" log entries (should match completed workflows)
2. Track "Failed to mark PR ready" warnings (should be <5%)
3. Verify no uncaught exceptions in worker logs
4. Collect user feedback on reviewer notification timing

---

## Implementation Checklist

- [ ] Add `markReadyForReview()` method to `PrManager` class
- [ ] Add unit tests for `markReadyForReview()` (success, no PR, error)
- [ ] Update `claude-cli-worker.ts` to call `markReadyForReview()` on completion
- [ ] Add info-level log before calling `markReadyForReview()`
- [ ] Add unit tests for worker integration (completed, gate, failure)
- [ ] Update CHANGELOG.md with feature description
- [ ] Run full test suite (`pnpm test`)
- [ ] Manual E2E test on staging
- [ ] Monitor production logs after deployment

---

*Plan generated 2026-02-21*
