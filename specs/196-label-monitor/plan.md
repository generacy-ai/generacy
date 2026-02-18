# Implementation Plan: Label Monitor with Webhook/Poll Hybrid Detection

**Feature**: Label monitor for the orchestrator — detects `process:*` trigger labels and `waiting-for:*/completed:*` resume pairs
**Branch**: `feature/196-label-monitor`
**Status**: Complete

## Summary

Add a `LabelMonitorService` to `@generacy-ai/orchestrator` that watches configured repositories for label events using a hybrid webhook + polling approach. When a `process:*` label is detected on an issue, the monitor parses the workflow name, checks Redis-based deduplication, enqueues the issue, removes the trigger label, and adds `agent:in-progress`. A polling fallback ensures no events are missed when webhooks are unavailable.

## Technical Context

- **Language**: TypeScript (ES2022, Node16 modules)
- **Framework**: Fastify 5 (existing server infrastructure)
- **Runtime**: Node.js
- **Dependencies**: Redis (via `ioredis`), `@generacy-ai/workflow-engine` (GitHubClient)
- **Test Framework**: Vitest
- **Validation**: Zod schemas
- **Existing patterns**: Service classes with dependency injection, Zod config schemas, Fastify route registration

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── config/
│   │   └── schema.ts                    # MODIFY: Add MonitorConfigSchema
│   ├── services/
│   │   ├── index.ts                     # MODIFY: Export new services
│   │   ├── label-monitor-service.ts     # NEW: Core monitor service
│   │   └── phase-tracker-service.ts     # NEW: Redis deduplication
│   ├── routes/
│   │   ├── index.ts                     # MODIFY: Register webhook route
│   │   └── webhooks.ts                  # NEW: Webhook endpoint
│   ├── server.ts                        # MODIFY: Initialize monitor
│   └── index.ts                         # MODIFY: Export new types/services
├── tests/
│   └── unit/
│       └── services/
│           ├── label-monitor-service.test.ts   # NEW
│           └── phase-tracker-service.test.ts   # NEW
```

## Architecture

### Component Overview

```
GitHub Webhook ──→ POST /webhooks/github ──→ WebhookHandler
                                                  │
                                                  ├──→ parseLabelEvent()
                                                  ├──→ PhaseTracker.isDuplicate()
                                                  ├──→ RedisQueue.enqueue()
                                                  └──→ GitHubClient.removeLabels() + addLabels()

Polling Loop ──→ LabelMonitorService.poll()
                      │
                      ├──→ For each watched repo:
                      │    ├──→ GitHubClient.listIssuesWithLabel("process:*")
                      │    ├──→ PhaseTracker.isDuplicate()
                      │    ├──→ RedisQueue.enqueue()
                      │    └──→ GitHubClient.removeLabels() + addLabels()
                      │
                      └──→ Adaptive interval based on webhook health
```

### Key Design Decisions

1. **Shared processing logic**: Both webhook and polling paths call the same `processLabelEvent()` method, ensuring consistent behavior.

2. **Dependency injection**: `LabelMonitorService` receives `GitHubClient`, `PhaseTracker`, and a queue interface via constructor, enabling testability without live services.

3. **Redis for deduplication only**: The phase tracker uses Redis `SET` with TTL for deduplication keys. The queue itself uses Redis sorted sets (implemented in a separate epic child issue). For this issue, we define a `QueueAdapter` interface that the monitor calls to enqueue; the actual Redis sorted-set queue is implemented in the sibling issue.

4. **Polling uses GitHub Search API**: Instead of listing all issues per repo, use `label:process:*` search qualifier to find issues with trigger labels efficiently.

5. **Webhook signature verification**: Use HMAC-SHA256 verification of the `X-Hub-Signature-256` header when `WEBHOOK_SECRET` is configured. Skip verification if not configured (development mode).

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `src/services/label-monitor-service.ts` | Core monitor with polling loop, label processing, adaptive frequency |
| `src/services/phase-tracker-service.ts` | Redis-based deduplication (SET with TTL) |
| `src/routes/webhooks.ts` | Fastify route for `POST /webhooks/github` with signature verification |
| `tests/unit/services/label-monitor-service.test.ts` | Unit tests for monitor logic |
| `tests/unit/services/phase-tracker-service.test.ts` | Unit tests for phase tracker |

### Modified Files

| File | Change |
|------|--------|
| `src/config/schema.ts` | Add `MonitorConfigSchema` with poll interval, webhook secret, adaptive polling |
| `src/services/index.ts` | Export `LabelMonitorService`, `PhaseTrackerService` |
| `src/routes/index.ts` | Register webhook route, pass monitor service |
| `src/server.ts` | Instantiate `LabelMonitorService`, start polling on server ready, stop on shutdown |
| `src/index.ts` | Export new types and services |

## Interface Design

### QueueAdapter (interface for enqueuing)

```typescript
interface QueueAdapter {
  enqueue(item: QueueItem): Promise<void>;
}

interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue';
  priority: number;
}
```

### PhaseTrackerService

```typescript
interface PhaseTracker {
  isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean>;
  markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void>;
}
```

### LabelMonitorService

```typescript
interface LabelMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}
```

## Implementation Order

1. **Config schema** — extend `OrchestratorConfigSchema` with monitor settings
2. **Phase tracker** — Redis dedup service (simple SET/GET with TTL)
3. **Label monitor service** — core processing logic + polling loop
4. **Webhook route** — Fastify endpoint with signature verification
5. **Server integration** — wire everything together in `server.ts`
6. **Tests** — unit tests for each component

## Dependencies

- `ioredis` — Redis client (already in package.json or add)
- `@generacy-ai/workflow-engine` — `GitHubClient`, `createGitHubClient` (already a dependency)
- No new external dependencies needed beyond ioredis

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| GitHub API rate limits during polling | `maxConcurrentPolls` limits parallel API calls; adaptive polling reduces frequency when webhooks are healthy |
| Redis unavailable | Phase tracker gracefully degrades — treat as "not duplicate" and log warning |
| Webhook secret misconfiguration | Clear error logging; optional verification allows dev mode without secret |

---

*Generated by speckit*
