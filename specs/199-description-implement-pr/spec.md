# Feature: PR Feedback Monitor for Orchestrated Issues

**Issue**: [#199](https://github.com/generacy-ai/generacy/issues/199)
**Parent Epic**: [#195 - Implement label-driven orchestrator package](https://github.com/generacy-ai/generacy/issues/195)
**Status**: Draft

## Overview

Implement the PR Feedback Monitor that detects unresolved review comments on pull requests linked to orchestrated issues and automatically triggers the feedback-addressing flow. The monitor listens for GitHub PR review webhooks (or polls as fallback), identifies PRs associated with orchestrated issues, adds `waiting-for:address-pr-feedback` labels, and enqueues the issue for the worker to spawn an agent that addresses the feedback without auto-resolving threads.

## Context

The orchestrator already has comprehensive infrastructure for monitoring issues, managing queues, and executing workflows via the Claude CLI worker:

- **LabelMonitorService** (issue #196) — Detects `process:*` and `completed:*`/`waiting-for:*` labels on issues
- **RedisQueueAdapter** (issue #197) — Priority queue with atomic claim/complete/release
- **WorkerDispatcher** (issue #197) — Dispatches workers with concurrency limits and heartbeat monitoring
- **ClaudeCliWorker** (issue #198) — Executes speckit workflow phases and manages label transitions

The PR Feedback Monitor extends this system to handle a new event source: **pull request review comments**. When a developer submits a review with unresolved comments on a PR linked to an orchestrated issue, the monitor must detect this, add the appropriate waiting label, and trigger a specialized feedback-addressing workflow phase.

Unlike the issue label monitor, which watches for labels on issues, this component watches for **review events on pull requests** and links them back to their parent issues via PR body references (e.g., "Closes #123") or branch naming conventions (e.g., "123-feature-name").

## User Stories

1. **As an orchestrator operator**, I want the system to detect when a PR linked to an orchestrated issue receives review comments so that the agent can automatically address feedback without manual intervention.

2. **As a developer**, I want to submit review comments on orchestrated PRs knowing that the agent will read them, make appropriate changes, and reply with explanations, but never auto-resolve my review threads so that I maintain final approval control.

3. **As an orchestrator operator**, I want PR-to-issue linking to work via multiple methods (PR body references, branch naming) so that the system can reliably associate PRs with their parent issues.

4. **As an orchestrator operator**, I want webhook-based detection with polling fallback so that feedback events are never missed, even if webhooks are unavailable.

5. **As an orchestrator operator**, I want the feedback-addressing flow to integrate seamlessly with the existing phase loop so that addressing feedback is just another workflow phase with proper label management and state tracking.

## Existing Code

| Component | Package | Path |
|-----------|---------|------|
| `LabelMonitorService` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/label-monitor-service.ts` |
| `RedisQueueAdapter` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/redis-queue-adapter.ts` |
| `WorkerDispatcher` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/worker-dispatcher.ts` |
| `ClaudeCliWorker` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/claude-cli-worker.ts` |
| `PhaseTrackerService` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/phase-tracker-service.ts` |
| Config schema | `@generacy-ai/orchestrator` | `packages/orchestrator/src/config/schema.ts` |
| `WORKFLOW_LABELS` | `@generacy-ai/workflow-engine` | `packages/workflow-engine/src/actions/github/label-definitions.ts` |
| Server setup | `@generacy-ai/orchestrator` | `packages/orchestrator/src/server.ts` |

## Functional Requirements

### FR-1: PR Review Webhook Reception

- Accept GitHub webhook events for PR reviews via a new Fastify route: `/webhooks/github/pr-review`
- Listen for event types:
  - `pull_request_review.submitted` — when a review is submitted with comments
  - `pull_request_review_comment.created` — when an individual review comment is added
- Validate webhook signature using `WEBHOOK_SECRET` (if configured, same mechanism as issue webhook)
- Parse the PR number, repository owner/repo, and review state from the event payload
- Filter for reviews with state `changes_requested` or `commented` (ignore `approved` reviews)
- Extract PR body and branch name for issue linking

### FR-2: PR-to-Issue Linking

- Link PRs to their parent issues using multiple detection methods:
  - **PR body references**: Parse PR body for GitHub closing keywords (`Closes #123`, `Fixes #456`, etc.)
  - **Branch naming convention**: Extract issue number from branch names matching pattern `{number}-{description}` (e.g., `199-pr-feedback-monitor`)
- If multiple issues are linked via body references, use the first one
- If both methods find issues, prefer the PR body reference
- If no issue is linked, log a warning and skip processing (PR is not orchestrated)
- Validate that the linked issue exists and has an `agent:*` label (indicating it's orchestrated)

### FR-3: Unresolved Comment Detection

- Query the GitHub API to fetch all review threads for the PR
- Filter for threads with `resolved: false`
- If no unresolved threads exist, skip processing (review may have been resolved manually)
- Parse unresolved review comments to extract:
  - Comment body text
  - File path and line number (for inline comments)
  - Thread ID (for replying)
  - Reviewer username

### FR-4: Label and Queue Management

- When unresolved review comments are detected on a linked orchestrated PR:
  - Add `waiting-for:address-pr-feedback` label to the linked issue
  - Enqueue a `QueueItem` to the Redis queue with:
    - `command: 'address-pr-feedback'`
    - `owner`, `repo`, `issueNumber` (of the linked issue)
    - `workflowName` (preserve existing workflow, e.g., `speckit-feature`)
    - `priority` (timestamp-based for FIFO)
    - Metadata: `{ prNumber, reviewThreadIds: [...] }`
- Use `PhaseTrackerService` for deduplication with key pattern: `phase-tracker:{owner}:{repo}:{issue}:address-pr-feedback`
- If a duplicate entry exists (same issue already enqueued for feedback), skip and log

### FR-5: Worker Handler for Address-PR-Feedback Command

- Extend the `ClaudeCliWorker` to handle `command: 'address-pr-feedback'` in addition to `process` and `continue`
- When handling `address-pr-feedback`:
  - Fetch all unresolved review threads from the PR
  - Construct a prompt for Claude CLI that includes:
    - "You are addressing PR review feedback. Read the comments below, make the necessary changes, and reply to each comment explaining what you changed. Never resolve the threads yourself."
    - List of unresolved comments with file paths, line numbers, and reviewer requests
    - Link to the PR for context
  - Spawn Claude CLI with the prompt and the repository checkout
  - After Claude completes:
    - Push the changes to the PR branch
    - Reply to each review comment thread via GitHub API with the agent's explanation
    - **Never call the "resolve thread" API** — leave threads unresolved for human review
    - Remove `waiting-for:address-pr-feedback` label
    - Add `completed:address-pr-feedback` label (optional, for tracking)

### FR-6: Polling Fallback

- Implement a polling loop (similar to `LabelMonitorService` polling) that:
  - Runs at a configurable interval (`PR_POLL_INTERVAL_MS`, default 60000ms)
  - For each watched repository, list open PRs
  - For each PR, check for unresolved review threads
  - Link PR to issue using FR-2 logic
  - If unresolved threads exist on an orchestrated PR, process same as webhook path (FR-4)
- Polling acts as a fallback for missed webhook events
- Adaptive polling: increase frequency if webhooks disconnect (same pattern as label monitor)

### FR-7: Configuration

- Extend the orchestrator config schema with PR monitor settings:
  - `prMonitor.enabled` (default: true)
  - `prMonitor.pollIntervalMs` (default: 60000)
  - `prMonitor.webhookSecret` (shared with issue webhook, optional)
  - `prMonitor.adaptivePolling` (default: true)
  - `prMonitor.maxConcurrentPolls` (default: 3)

### FR-8: Error Handling

- **PR not found**: Log warning, skip processing
- **Issue not found**: Log warning, skip processing
- **GitHub API rate limit**: Respect rate limit headers, pause polling until reset
- **Webhook signature mismatch**: Return 401 Unauthorized
- **Invalid PR body/branch**: Log warning, use fallback linking method
- **Worker failure**: Standard error handling from `ClaudeCliWorker` applies (adds `agent:error` label)

## Non-Functional Requirements

- **Latency**: Webhook path should enqueue within 500ms of receiving the event
- **Reliability**: Polling must catch any event missed by webhooks within one poll cycle
- **Observability**: Structured logging for all PR events, linking resolutions, enqueue actions, and comment replies
- **Testability**: Core PR-to-issue linking, thread detection, and enqueue logic must be testable without live GitHub API
- **Graceful Shutdown**: Stop polling loop and drain in-flight webhook handlers on server shutdown
- **Idempotency**: Re-processing the same PR review event should not duplicate labels or queue entries

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | PR review event detection latency (webhook) | < 500ms from event to enqueue | Structured log timestamps |
| SC-002 | PR-to-issue linking accuracy | > 95% success rate | Manual validation on test PRs |
| SC-003 | Polling fallback coverage | 100% of missed webhooks caught within 1 poll cycle | Integration test with webhook disabled |
| SC-004 | Deduplication effectiveness | 0 duplicate enqueues for same PR feedback event | Redis phase tracker query |
| SC-005 | Agent feedback response completeness | 100% of unresolved comments receive agent reply | GitHub API validation |
| SC-006 | Thread auto-resolve prevention | 0% of threads auto-resolved by agent | GitHub API validation |

## Assumptions

- GitHub webhooks are configured to send `pull_request_review` events to the orchestrator's webhook endpoint
- The orchestrator has `GITHUB_TOKEN` with permissions to read PRs, review comments, and write comments
- PRs linked to orchestrated issues follow either PR body reference or branch naming conventions
- Developers want the agent to address feedback but retain final approval control (no auto-resolve)
- The repository is already cloned/available in the worker's workspace when the worker processes the `address-pr-feedback` command

## Out of Scope

- **Automatic PR creation**: This monitor only handles feedback on existing PRs (PR creation is part of the `implement` phase in `ClaudeCliWorker`)
- **Multi-PR support per issue**: If an issue has multiple PRs, only the most recently updated PR with unresolved comments is processed
- **Feedback quality validation**: The agent is expected to make a best-effort response; no automated check for response quality
- **Conflict resolution**: If the agent's changes conflict with other commits, standard Git merge conflict handling applies (agent may fail and add `agent:error`)
- **Review assignment**: The monitor does not assign reviewers or request re-review after addressing feedback
- **Dashboard UI**: Streaming of feedback-addressing activity to the dashboard uses the existing SSE infrastructure; no new UI components
- **Rate limit mitigation**: Beyond respecting GitHub's rate limit headers and pausing polling, no advanced rate limit strategies (e.g., token rotation)
- **Webhook registration automation**: Assumes webhooks are configured manually in GitHub (same as issue label webhooks)

---

*Generated by speckit*
