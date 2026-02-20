# Feature Specification: PR Feedback Monitor

Implement the PR Feedback Monitor that detects unresolved review comments on PRs linked to orchestrated issues and triggers the feedback-addressing flow.

**Branch**: `199-description-implement-pr` | **Date**: 2026-02-20 | **Status**: Draft | **Epic**: generacy#195

## Summary

The PR Feedback Monitor is a new orchestrator service that closes the loop between code review and automated implementation. When a reviewer leaves comments on a pull request linked to an orchestrated issue, the monitor detects the unresolved review threads, labels the linked issue with `waiting-for:address-pr-feedback`, and enqueues a feedback-addressing command. A worker then spawns a Claude CLI agent that reads the review comments, makes the requested changes, pushes to the PR branch, and replies to each thread explaining what was changed — without ever auto-resolving the threads. This ensures reviewers retain full control over thread resolution while the agent handles the mechanical work of addressing feedback.

The service follows the proven hybrid webhook + polling architecture established by `LabelMonitorService`, integrates with the existing Redis queue and worker dispatcher, and extends the `ClaudeCliWorker` with a new `address-pr-feedback` command.

## User Stories

### US1: Automated PR Feedback Detection

**As a** project maintainer using the orchestrator,
**I want** unresolved PR review comments to be automatically detected on orchestrated PRs,
**So that** feedback is addressed promptly without manual monitoring.

**Acceptance Criteria**:
- [ ] Webhook events (`pull_request_review.submitted`, `pull_request_review_comment.created`) trigger detection within 500ms
- [ ] Polling fallback detects unresolved threads within one poll cycle when webhooks are unavailable
- [ ] Only PRs linked to orchestrated issues (with `agent:*` labels) are processed
- [ ] PRs on non-watched repositories are ignored
- [ ] Detection is idempotent — duplicate events do not produce duplicate queue items

### US2: Agent Addresses Review Feedback

**As a** code reviewer,
**I want** the agent to read my review comments, make the appropriate code changes, push them, and reply explaining what was changed,
**So that** I can quickly verify the changes without waiting for a human developer.

**Acceptance Criteria**:
- [ ] Agent checks out the existing PR branch (not the default branch)
- [ ] Agent fetches fresh unresolved threads at processing time (not stale metadata)
- [ ] Agent receives a prompt containing all unresolved review comments with file paths and line numbers
- [ ] Changes are committed and pushed to the PR branch
- [ ] Each unresolved thread receives a single consolidated reply explaining the change
- [ ] Review threads are never auto-resolved by the agent
- [ ] `waiting-for:address-pr-feedback` label is removed from the linked issue upon completion

### US3: PR-to-Issue Linking

**As a** developer,
**I want** the system to automatically link PRs to their orchestrated issues using PR body references or branch naming conventions,
**So that** I don't need to manually configure PR-to-issue mappings.

**Acceptance Criteria**:
- [ ] PR body keywords (`Closes #N`, `Fixes #N`, `Resolves #N`) are detected (case-insensitive)
- [ ] Branch name pattern (`{N}-{description}`) is used as fallback when PR body has no reference
- [ ] PR body reference takes priority over branch name
- [ ] When a PR references multiple issues, only the first issue is used
- [ ] Non-orchestrated issues (no `agent:*` label) are skipped
- [ ] Linking accuracy exceeds 95% across standard PR conventions

### US4: Resilient Monitoring with Polling Fallback

**As a** system operator,
**I want** the PR monitor to automatically increase polling frequency when webhooks are unhealthy,
**So that** feedback detection continues reliably even during webhook outages.

**Acceptance Criteria**:
- [ ] Polling interval decreases by 50% when no webhook received in 2x the configured interval
- [ ] Polling interval resets to configured value when a webhook is received
- [ ] Concurrent polling is limited by `maxConcurrentPolls` across all watched repositories
- [ ] Polling gracefully handles GitHub API rate limits
- [ ] Monitor stops cleanly on server shutdown without data loss

### US5: Observable Feedback Workflow

**As a** system operator monitoring the orchestrator dashboard,
**I want** to see real-time progress of PR feedback addressing via SSE events and structured logs,
**So that** I can diagnose issues and track system health.

**Acceptance Criteria**:
- [ ] SSE events are emitted for `workflow:started`, `workflow:progress`, and `workflow:completed` with `command: 'address-pr-feedback'`
- [ ] Structured log entries are produced for: feedback detection, enqueue, worker processing, thread replies, and errors
- [ ] Label state transitions (`waiting-for:address-pr-feedback` add/remove) are logged

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Listen for `pull_request_review.submitted` and `pull_request_review_comment.created` webhook events on a dedicated `/webhooks/github/pr-review` endpoint | P1 | HMAC-SHA256 signature verification using shared webhook secret |
| FR-002 | Link PRs to orchestrated issues via PR body closing keywords (priority) and branch name pattern (fallback) | P1 | First matched issue only; verify issue has `agent:*` label |
| FR-003 | Detect unresolved review threads by checking `resolved: false` status on PR review comments | P1 | Ignore review state (`changes_requested`, `approved`, etc.); thread resolution is the source of truth |
| FR-004 | Enqueue `address-pr-feedback` command to Redis queue with `metadata: { prNumber, reviewThreadIds }` when unresolved threads are detected | P1 | Deduplicate via `PhaseTrackerService` with key `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback` |
| FR-005 | Add `waiting-for:address-pr-feedback` label to the linked issue upon enqueue | P1 | Do not modify existing phase labels (`phase:*`, `process:*`) |
| FR-006 | Worker checks out the PR branch, spawns Claude CLI with a prompt containing all unresolved review comments, pushes changes, and replies to each thread | P1 | Single consolidated reply per thread; never call resolve-thread API |
| FR-007 | Remove `waiting-for:address-pr-feedback` label from linked issue after worker completes successfully | P1 | On partial failure (reply posting), still remove label and log warnings |
| FR-008 | Poll open PRs on watched repositories for unresolved review threads as a fallback detection mechanism | P1 | Concurrency limited by `maxConcurrentPolls` (default 3) across all repos |
| FR-009 | Implement adaptive polling: increase frequency when no webhooks received in 2x `pollIntervalMs` | P2 | Mirror `LabelMonitorService` adaptive polling pattern |
| FR-010 | Extend `QueueItem.command` type union to include `'address-pr-feedback'` and add optional `metadata` field | P1 | Backward-compatible; existing `process`/`continue` commands unaffected |
| FR-011 | Add `PrMonitorConfig` to orchestrator config schema with `enabled`, `pollIntervalMs`, `webhookSecret`, `adaptivePolling`, `maxConcurrentPolls` | P1 | Validated with zod; defaults: enabled=true, pollIntervalMs=60000, maxConcurrentPolls=3 |
| FR-012 | Route `address-pr-feedback` command in `ClaudeCliWorker.handle()` to a new `PrFeedbackHandler` class | P1 | Early return after handler completes; do not fall through to process/continue logic |
| FR-013 | Handle worker timeout with partial completion strategy: push partial changes, keep `waiting-for` label for retry | P2 | Do not roll back partial work; re-enqueue on next detection cycle |
| FR-014 | Resolve workflow name from issue labels (`process:*` or `completed:*`) when enqueuing | P1 | Required for `QueueItem.workflowName` field |
| FR-015 | When multiple PRs exist for the same issue, process only the most recently updated PR | P2 | Log a warning when older PRs with unresolved comments are skipped |
| FR-016 | Initialize `PrFeedbackMonitorService` in server startup, register webhook routes, start polling in `onReady` hook, and stop polling in graceful shutdown | P1 | Skip initialization when `prMonitor.enabled = false` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Webhook-to-enqueue latency | < 500ms | Timestamp delta from webhook receipt to `queueAdapter.enqueue()` completion |
| SC-002 | PR-to-issue linking accuracy | > 95% | Validate against 100 test PRs with standard conventions |
| SC-003 | Polling fallback coverage | 100% | Integration test: disable webhooks, verify poll detects unresolved threads within one cycle |
| SC-004 | Deduplication effectiveness | 0 duplicate enqueues | Send identical events via webhook + poll concurrently; verify single queue item |
| SC-005 | Reply completeness | 100% | Verify all unresolved threads receive an agent reply after processing |
| SC-006 | Thread auto-resolve prevention | 0% auto-resolved | Verify `resolved: false` status unchanged on all threads after agent replies |

## Assumptions

- The orchestrator already has a functioning `LabelMonitorService`, `RedisQueueAdapter`, `WorkerDispatcher`, and `ClaudeCliWorker` that this feature builds upon
- GitHub API access is available with sufficient permissions to read PR reviews, post review comments, and manage issue labels
- The `PhaseTrackerService` can be reused for deduplication with a new key pattern
- The `waiting-for:address-pr-feedback` label definition already exists in `WORKFLOW_LABELS`
- Repositories are already cloned/available in the worker's workspace (the existing checkout infrastructure handles this)
- A single webhook secret is shared between the issue label webhook and the PR review webhook
- The GitHub API rate limit (5000 req/hr for authenticated requests) is sufficient for the polling workload
- Review threads have a `resolved` boolean field accessible via the GitHub API

## Out of Scope

- Resolving review threads automatically (the agent replies but never resolves)
- Handling PRs not linked to orchestrated issues (no `agent:*` label)
- Processing multiple PRs per issue simultaneously (only the most recently updated PR is processed)
- Auto-merging PRs after feedback is addressed
- Supporting non-GitHub code hosting platforms (GitLab, Bitbucket)
- Custom per-repository polling intervals (a single global `pollIntervalMs` is used)
- Real-time metrics/dashboard (structured logs and SSE events are provided; Prometheus/Grafana integration is deferred)
- Handling review comments on closed or merged PRs
- Processing draft PR reviews or pending review comments (only submitted reviews and created comments)

---

*Generated by speckit*
