# Feature Specification: Reliable `agent:in-progress` Label Cleanup

**Branch**: `207-description-when-orchestrator` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

The orchestrator does not reliably remove the `agent:in-progress` label when a workflow finishes. The label is only removed inside `labelManager.onWorkflowComplete()` which runs in the happy-path `if (loopResult.completed)` block of `claude-cli-worker.ts`. If the process crashes, the container shuts down, or the GitHub API call fails after retries, the label is left behind. This creates confusion about whether the workflow actually completed. The fix ensures cleanup on every exit path — success, error, and crash — and adds reaper-level label cleanup for stale workers.

## Root Cause

1. **No `finally` block cleanup** — The `finally` block in `ClaudeCliWorker.handle()` (line 317) only calls `abortController.abort()`. It does not attempt to remove `agent:in-progress`.
2. **No reaper label cleanup** — `WorkerDispatcher.reapStaleWorkers()` (line 242) releases the queue item but does not remove stale labels from the issue.
3. **Misleading error logging** — The `catch` block (line 301) logs `'Worker encountered an unhandled error'` at error level even when all phases completed successfully and only post-completion work (e.g. marking PR ready) failed.

## User Stories

### US1: Reliable label cleanup on successful completion

**As a** developer monitoring orchestrator workflows,
**I want** the `agent:in-progress` label to be removed when all phases complete,
**So that** I can trust the label state reflects reality.

**Acceptance Criteria**:
- [ ] `agent:in-progress` is removed even if `markReadyForReview()` or SSE emission throws after `onWorkflowComplete()` succeeds
- [ ] `agent:in-progress` is removed even if the process exits unexpectedly after the phase loop returns `completed: true`
- [ ] Existing behavior for successful completion is unchanged (label removed, PR marked ready, SSE emitted)

### US2: Reliable label cleanup on worker crash or timeout

**As a** developer investigating stale workflows,
**I want** stale `agent:in-progress` labels to be cleaned up when the reaper detects a dead worker,
**So that** I don't have to manually remove misleading labels.

**Acceptance Criteria**:
- [ ] When the reaper detects an expired heartbeat, it removes `agent:in-progress` from the associated issue
- [ ] The reaper also removes any lingering `phase:*` labels from the issue
- [ ] If GitHub API calls fail during reaper cleanup, errors are logged but do not crash the reaper loop

### US3: Accurate error logging after phase completion

**As a** developer reading orchestrator logs,
**I want** log severity to reflect what actually happened,
**So that** I can triage alerts correctly.

**Acceptance Criteria**:
- [ ] If all phases completed but a post-completion step fails, the error is logged at `warn` level, not `error`
- [ ] If a phase actually failed, the error is still logged at `error` level
- [ ] Log messages distinguish between phase-execution failures and post-completion cleanup failures

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Move `agent:in-progress` removal into the `finally` block of `ClaudeCliWorker.handle()` so it runs on every exit path (success, error, crash) | P1 | The `finally` block should call `labelManager.onWorkflowComplete()` (or a new `ensureCleanup()` method) wrapped in try/catch so it never throws |
| FR-002 | Track whether all phases completed (e.g. a `phasesCompleted` boolean set before the completion branch) so the `finally` block knows whether to remove the label vs. leave it for a retry | P1 | On error paths where `onError()` already removes `agent:in-progress`, the `finally` cleanup should be a no-op or idempotent |
| FR-003 | Add label cleanup to `WorkerDispatcher.reapStaleWorkers()` — when a worker's heartbeat expires, remove `agent:in-progress` and any `phase:*` labels from the associated issue | P2 | Requires the `WorkerInfo` struct to carry `owner`, `repo`, `issueNumber` (already available via `worker.item`) |
| FR-004 | Downgrade the catch-block log in `ClaudeCliWorker.handle()` from `error` to `warn` when all phases completed successfully and the error occurred during post-completion work | P2 | Introduce a `phasesCompleted` flag to distinguish phase failures from cleanup failures |
| FR-005 | Ensure `onWorkflowComplete()` is idempotent — calling it when `agent:in-progress` is already absent should not throw or log an error | P2 | GitHub's label removal API already returns 200 if the label doesn't exist, but verify and handle 404 gracefully |
| FR-006 | Add a new `LabelManager.ensureCleanup()` method that removes `agent:in-progress` and any `phase:*` labels, with retry logic, designed to be safe to call from `finally` blocks | P3 | Should swallow errors after logging them at warn level |

## File Changes

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Add `phasesCompleted` flag; move label cleanup to `finally` block; downgrade post-completion error log severity |
| `packages/orchestrator/src/worker/label-manager.ts` | Add `ensureCleanup()` method; verify `onWorkflowComplete()` idempotency on 404 |
| `packages/orchestrator/src/services/worker-dispatcher.ts` | Add label cleanup in `reapStaleWorkers()` using `worker.item` metadata |
| `packages/orchestrator/src/worker/claude-cli-worker.test.ts` | Add tests for: cleanup in `finally` block, post-completion error logging at warn level |
| `packages/orchestrator/src/worker/label-manager.test.ts` | Add tests for: `ensureCleanup()`, idempotent removal when label absent |
| `packages/orchestrator/src/services/worker-dispatcher.test.ts` | Add tests for: reaper label cleanup on heartbeat expiry |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Stale `agent:in-progress` labels after successful completion | 0 occurrences | Monitor GitHub issues post-deployment; no `agent:in-progress` label should remain when all `completed:*` labels are present |
| SC-002 | Stale `agent:in-progress` labels after worker crash | Cleaned up within 1 reaper cycle | Verify via reaper logs that label cleanup fires on heartbeat expiry |
| SC-003 | Post-completion errors logged at correct severity | 100% of post-completion errors at `warn` level | Log audit: no `error`-level entries where `phasesCompleted === true` |
| SC-004 | All existing tests pass | 100% pass rate | CI pipeline |
| SC-005 | New test coverage for cleanup paths | Tests cover: finally-block cleanup, reaper cleanup, idempotent removal | Code review and test suite |

## Assumptions

- The GitHub API's label removal endpoint is idempotent (removing a label that doesn't exist returns success or a 404 that can be safely ignored)
- The `WorkerInfo` struct's `item` field always contains valid `owner`, `repo`, and `issueNumber` for the duration of the worker's lifetime
- The reaper loop has access to a GitHub client or can construct one from the worker's context
- Process-level crashes (e.g. OOM kills) cannot be caught by `finally` blocks — the reaper is the only safety net for those cases

## Out of Scope

- Periodic reconciliation job that scans all open issues for stale `agent:in-progress` labels (would be a separate scheduled task)
- Webhook-based cleanup triggered by container shutdown signals (SIGTERM handling)
- Changes to the `agent:paused` or `agent:error` label lifecycle — those paths already clean up `agent:in-progress` correctly
- Changes to `LabelMonitorService.processLabelEvent()` — label addition logic is not affected
- UI/dashboard changes to surface stale label warnings

---

*Generated by speckit*
