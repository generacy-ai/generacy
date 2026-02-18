# Clarifications: Label Monitor

## Batch 1 — 2026-02-18

### Q1: QueueAdapter vs Existing QueueService
**Context**: The spec defines a `QueueAdapter` interface with `enqueue(item: QueueItem)` for workflow processing items (owner, repo, issueNumber, workflowName, command, priority). However, the existing `QueueService` uses a completely different `MessageRouter` interface for "decision" items (approval, choice, input, review) with priority levels like `blocking_now`, `blocking_soon`, `when_available`. These are fundamentally different queue models.
**Question**: Should the `QueueAdapter` be a new, separate queuing interface (independent of the existing `QueueService`), or should it adapt/wrap the existing `MessageRouter`?
**Options**:
- A: New separate interface — `QueueAdapter` is independent; the actual Redis sorted-set queue will be implemented in a sibling epic child issue
- B: Wrap existing `QueueService` — map workflow items to the existing decision queue model
- C: Replace `QueueService` — the new `QueueAdapter` supersedes the existing decision queue

**Answer**: A — New separate interface. `QueueAdapter` is independent of the existing `QueueService`/`MessageRouter`. The actual Redis sorted-set queue will be implemented in a sibling epic child issue. For now, tests can use an in-memory adapter.

### Q2: GitHubClient Issue Methods
**Context**: The spec requires `listIssuesWithLabel()`, `removeLabels()`, and `addLabels()` operations on issues. The existing `LabelSyncService` only uses label CRUD methods (`listLabels`, `createLabel`, `updateLabel`) from `GitHubClient`. If the `@generacy-ai/workflow-engine` package doesn't expose issue-related methods, these would need to be added first.
**Question**: Does the `GitHubClient` in `@generacy-ai/workflow-engine` already support issue-level operations (list issues by label, add/remove labels on issues), or should the monitor implement these directly via the GitHub REST API?
**Options**:
- A: GitHubClient already has these methods — use them directly
- B: Add methods to GitHubClient first — extend the workflow-engine package as a prerequisite
- C: Use GitHub REST API directly — the monitor makes its own API calls using Octokit/fetch with the configured token

**Answer**: B — Add methods to `GitHubClient` in `@generacy-ai/workflow-engine` first. The monitor should use the existing client abstraction, but issue-level methods (`listIssuesWithLabel`, `addLabels`, `removeLabels`) need to be added as a prerequisite.

### Q3: Webhook Route Authentication
**Context**: The orchestrator server applies auth middleware as a global `preHandler` hook (API key or GitHub OAuth). The webhook endpoint receives requests from GitHub's servers, which don't have API keys or OAuth tokens. The spec mentions HMAC-SHA256 signature verification but doesn't address how to bypass the existing auth middleware.
**Question**: Should the webhook route bypass the global auth middleware entirely (relying solely on HMAC signature verification), or should it use a different auth strategy?
**Options**:
- A: Bypass global auth — exclude `/webhooks/*` from the `preHandler` auth hook; rely on HMAC signature verification only
- B: Dedicated webhook auth — add a separate auth strategy for webhooks that the existing middleware supports
- C: No auth needed — webhooks are on a separate port or path prefix that's outside the auth boundary

**Answer**: A — Bypass global auth. Exclude `/webhooks/*` from the `preHandler` auth hook and rely solely on HMAC-SHA256 signature verification for webhook routes.

### Q4: Initial Webhook Health State
**Context**: The adaptive polling spec says to reduce poll interval by 3x when webhooks are "unhealthy" (no event received within `2 * pollIntervalMs`). At startup, `lastWebhookEvent` is `null` — no webhook has ever been received. This creates ambiguity about initial polling behavior.
**Question**: At startup (before any webhook event is received), should the monitor assume webhooks are healthy (normal poll rate) or unhealthy (fast poll rate)?
**Options**:
- A: Assume healthy — start at normal poll rate; only switch to fast rate if webhooks were working and then stop
- B: Assume unhealthy — start at fast poll rate until the first webhook event confirms connectivity
- C: Configurable — add a `webhookExpected` config option that controls initial assumption

**Answer**: A — Assume healthy at startup. Start at normal poll rate. Only switch to fast rate if webhooks were previously active and then stop responding.

### Q5: Redis Client Lifecycle
**Context**: The `ioredis` package is already in `package.json` and the config has `redis.url`, but no Redis client is currently instantiated in the server. The `PhaseTrackerService` needs a Redis connection. Future services (queue) will also need Redis.
**Question**: Should the monitor create its own Redis client, or should a shared Redis client be created at the server level and injected into services that need it?
**Options**:
- A: Shared client — create a single `ioredis` instance in `server.ts` and inject into `PhaseTrackerService` (and later the queue service)
- B: Per-service clients — each service creates its own Redis connection from the config URL
- C: Connection pool — create a Redis connection factory/pool at the server level

**Answer**: A — Shared client. Create a single `ioredis` instance in `server.ts` and inject it into `PhaseTrackerService` (and later the queue service).

---

*Generated by speckit*
