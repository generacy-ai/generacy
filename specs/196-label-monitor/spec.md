# Feature: Label Monitor with Webhook/Poll Hybrid Detection

**Issue**: [#196](https://github.com/generacy-ai/generacy/issues/196)
**Parent Epic**: [#195 - Implement label-driven orchestrator package](https://github.com/generacy-ai/generacy/issues/195)
**Status**: Draft

## Overview

Implement the Monitor component of the orchestrator that watches configured repositories for `process:*` trigger labels on issues using a hybrid webhook + polling approach. When a trigger label is detected, the monitor parses the workflow name, enqueues the issue to a Redis queue, removes the trigger label, and adds an `agent:in-progress` label. It also handles `waiting-for:*` + `completed:*` label pair detection for resume flows.

## Context

The orchestrator is the core engine that drives automated backlog development. It needs a reliable way to detect when a developer adds a `process:*` label to a GitHub issue, which signals that the issue is ready for automated processing. The monitor is the entry point — it detects these label events and feeds them into the Redis queue for worker processing.

The orchestrator package already exists at `packages/orchestrator/` with Fastify-based server infrastructure, authentication, rate limiting, SSE endpoints, label sync service, and a configuration schema that includes `repositories` (watched repos) and `redis` connection settings. The monitor builds on this foundation.

## User Stories

1. **As an orchestrator operator**, I want the monitor to detect `process:*` labels on issues in watched repositories so that issues are automatically enqueued for workflow processing.
2. **As an orchestrator operator**, I want webhook-based detection for near-instant response times, with polling as a fallback, so that label events are never missed.
3. **As an orchestrator operator**, I want `waiting-for:*` + `completed:*` label pair detection so that paused workflows can automatically resume when review gates are satisfied.
4. **As an orchestrator operator**, I want deduplication so that the same issue is not enqueued twice for the same workflow phase.

## Existing Code

| Component | Package | Path |
|-----------|---------|------|
| `LabelSyncService` | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/label-sync-service.ts` |
| Orchestrator config | `@generacy-ai/orchestrator` | `packages/orchestrator/src/config/schema.ts` |
| Server setup | `@generacy-ai/orchestrator` | `packages/orchestrator/src/server.ts` |
| Queue service | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/queue-service.ts` |
| SSE events | `@generacy-ai/orchestrator` | `packages/orchestrator/src/sse/events.ts` |
| GitHub client factory | `@generacy-ai/workflow-engine` | via `createGitHubClient` |
| `WORKFLOW_LABELS` | `@generacy-ai/workflow-engine` | label definitions |

## Functional Requirements

### FR-1: Webhook Event Reception

- Accept GitHub `issues.labeled` webhook events via a new Fastify route
- Validate webhook signature using `WEBHOOK_SECRET` (if configured)
- Parse the label name from the event payload
- Filter for `process:*` labels only; ignore all other label events
- Extract issue number, repository owner/repo, and label name

### FR-2: Trigger Label Processing

- Parse workflow name from the trigger label (e.g., `process:speckit-feature` → `speckit-feature`)
- Enqueue the issue to the Redis sorted-set queue with:
  - `issueNumber`, `owner`, `repo`, `workflowName`
  - Priority score (configurable, default: current timestamp for FIFO ordering)
- After successful enqueue:
  - Remove the `process:*` trigger label from the issue
  - Add `agent:in-progress` label to the issue
- Log the enqueue action with structured data

### FR-3: Polling Fallback

- Run a configurable-interval polling loop (`POLL_INTERVAL_MS`, default 30000ms)
- For each watched repository, list issues with `process:*` labels
- Process each discovered issue the same way as webhook events (FR-2)
- Polling acts as a safety net — it catches events missed by webhooks

### FR-4: Adaptive Polling Frequency

- Track webhook connection status (connected/disconnected)
- When webhooks are connected and healthy: poll at normal interval (`POLL_INTERVAL_MS`)
- When webhooks disconnect: increase polling frequency (e.g., `POLL_INTERVAL_MS / 3`, minimum 10s)
- When webhooks reconnect: restore normal polling frequency
- Log transitions between polling modes

### FR-5: Waiting-For/Completed Resume Detection

- Detect when a `completed:*` label is added to an issue
- Check if a matching `waiting-for:*` label exists on the same issue
- If a match is found (e.g., `completed:spec-review` + `waiting-for:spec-review`):
  - Enqueue a "continue" command for the issue
  - Remove the `waiting-for:*` label
- Both webhook and polling paths must support this detection

### FR-6: Deduplication via Phase Tracker

- Before enqueueing, check Redis for an existing entry for this issue+phase combination
- Key pattern: `phase-tracker:{owner}:{repo}:{issue}:{phase}`
- If a key exists (not expired), skip the enqueue and log the duplicate
- On successful enqueue, set the key with a 24-hour TTL
- TTL auto-cleans stale entries

### FR-7: Configuration

- Extend the orchestrator config schema with monitor-specific settings:
  - `monitor.pollIntervalMs` (default: 30000)
  - `monitor.webhookSecret` (optional)
  - `monitor.maxConcurrentPolls` (default: 5) — limits concurrent GitHub API calls during polling
  - `monitor.adaptivePolling` (default: true) — enable/disable adaptive polling behavior

## Non-Functional Requirements

- **Latency**: Webhook path should enqueue within 500ms of receiving the event
- **Reliability**: Polling must catch any event missed by webhooks within one poll cycle
- **Observability**: Structured logging for all label events, enqueue actions, and deduplication skips
- **Testability**: Core monitor logic must be testable without live GitHub API or Redis
- **Graceful Shutdown**: Stop polling loop and drain in-flight webhook handlers on server shutdown

## Success Criteria

- [ ] Detects `process:*` labels via webhook events
- [ ] Falls back to polling when webhooks unavailable
- [ ] Enqueues issues with correct workflow name
- [ ] Removes trigger labels after enqueueing
- [ ] Detects `waiting-for:*` + `completed:*` pairs for resume
- [ ] Deduplication prevents double-processing
- [ ] Configurable watched repositories
- [ ] Adaptive polling frequency based on webhook health

## Clarified Decisions

- **QueueAdapter**: New separate interface, independent of the existing `QueueService`/`MessageRouter` (which handles "decision" items). The actual Redis sorted-set queue will be implemented in a sibling epic child issue. For this issue, use an in-memory adapter for testing.
- **GitHubClient methods**: Issue-level methods (`listIssuesWithLabel`, `addLabels`, `removeLabels`) must be added to `GitHubClient` in `@generacy-ai/workflow-engine` as a prerequisite before the monitor can use them.
- **Webhook authentication**: The webhook route (`/webhooks/*`) bypasses the global `preHandler` auth middleware. Authentication is handled solely via HMAC-SHA256 signature verification of the `X-Hub-Signature-256` header.
- **Initial webhook health**: At startup, assume webhooks are healthy (normal poll rate). Only switch to fast polling if webhooks were previously active and then stop responding. `lastWebhookEvent === null` is treated as "no data yet", not "unhealthy".
- **Redis client**: A single shared `ioredis` instance is created in `server.ts` and injected into `PhaseTrackerService` (and later the queue service).

## Out of Scope

- Worker implementation (separate issue: Redis queue consumer + Claude CLI spawner)
- PR feedback monitoring (separate issue in epic #195)
- Stage comment management (separate issue in epic #195)
- GitHub App authentication (uses existing `GITHUB_TOKEN` for now)
- Horizontal scaling / multi-instance coordination
- Webhook registration automation (assumes webhooks are configured manually in GitHub)

---

*Generated by speckit*
