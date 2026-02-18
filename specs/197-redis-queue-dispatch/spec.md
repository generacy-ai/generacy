# Feature: Redis Queue with Worker Claim and Dispatch

**Issue**: [#197](https://github.com/generacy-ai/generacy/issues/197)
**Parent Epic**: [#195 - Implement label-driven orchestrator package](https://github.com/generacy-ai/generacy/issues/195)
**Status**: Draft

## Overview

Implement the Redis-based sorted-set queue and worker dispatcher for the orchestrator. The queue provides priority-based ordering of issue processing requests, while the dispatcher manages concurrent worker execution with heartbeat-based health monitoring and automatic stale claim recovery.

## Context

The orchestrator's label monitor (issue #196) detects `process:*` labels on GitHub issues and enqueues them for processing. This issue implements the backing queue and the dispatcher that consumes from it. The `QueueAdapter` interface already exists in `packages/orchestrator/src/types/monitor.ts`, and the monitor currently uses an in-memory placeholder. This issue replaces that placeholder with a production Redis sorted-set implementation and adds worker dispatch logic.

The existing codebase already includes:
- `ioredis` dependency and Redis client initialization in `server.ts`
- `QueueAdapter` interface with `enqueue(item: QueueItem): Promise<void>`
- `QueueItem` type with `owner`, `repo`, `issueNumber`, `workflowName`, `command`, `priority`, `enqueuedAt`
- `PhaseTrackerService` using Redis for deduplication
- Fastify server with SSE event broadcasting infrastructure

## User Stories

1. **As an orchestrator operator**, I want issues to be processed in priority order so that high-priority work is handled before lower-priority work.
2. **As an orchestrator operator**, I want atomic claim semantics so that no issue is dispatched to two workers simultaneously.
3. **As an orchestrator operator**, I want a configurable concurrency limit so that the system doesn't overwhelm resources by running too many workers at once.
4. **As an orchestrator operator**, I want heartbeat-based health monitoring so that if a worker dies, its claimed work is automatically returned to the queue for re-processing.
5. **As an orchestrator operator**, I want to query queue depth so that I can monitor system load from the dashboard.

## Existing Code

| Component | Package | Path |
|-----------|---------|------|
| `QueueAdapter` interface | `@generacy-ai/orchestrator` | `packages/orchestrator/src/types/monitor.ts` |
| `QueueItem` type | `@generacy-ai/orchestrator` | `packages/orchestrator/src/types/monitor.ts` |
| `QueueService` (decision queue) | `@generacy-ai/orchestrator` | `packages/orchestrator/src/services/queue-service.ts` |
| Redis config | `@generacy-ai/orchestrator` | `packages/orchestrator/src/config/schema.ts` |
| Server setup | `@generacy-ai/orchestrator` | `packages/orchestrator/src/server.ts` |
| SSE events | `@generacy-ai/orchestrator` | `packages/orchestrator/src/sse/events.ts` |
| Queue routes (decision) | `@generacy-ai/orchestrator` | `packages/orchestrator/src/routes/queue.ts` |

## Functional Requirements

### FR-1: Redis Sorted-Set Queue

- Implement a `RedisQueueAdapter` class that implements the existing `QueueAdapter` interface
- Use a Redis sorted set (`ZADD`) where the score is the priority value (lower = higher priority, timestamp-based for FIFO)
- Queue key: `orchestrator:queue:pending`
- Store serialized `QueueItem` as the sorted set member
- Support enqueue, claim, release, complete, and depth-query operations

### FR-2: Atomic Claim

- Use a Lua script or Redis transaction (`WATCH`/`MULTI`/`EXEC`) to atomically:
  1. Pop the lowest-score member from the pending sorted set (`ZPOPMIN`)
  2. Add it to an in-progress hash (`HSET orchestrator:queue:claimed:{workerId}`)
  3. Set a heartbeat TTL key (`orchestrator:worker:{workerId}:heartbeat`)
- If no items are available, return `null`
- The claim operation must be safe under concurrent access — no two workers can claim the same item

### FR-3: Release and Complete

- **Release**: Move a claimed item back to the pending sorted set (preserving original priority). Used when a worker fails or is explicitly stopped.
- **Complete**: Remove the claimed item entirely. Update labels on the issue via the label monitor's API or direct GitHub calls.
- Both operations must clean up the worker's claim hash entry

### FR-4: Worker Dispatcher

- Implement a `WorkerDispatcher` class that:
  - Polls the queue at a configurable interval (`DISPATCH_POLL_INTERVAL_MS`, default 5000ms)
  - Before claiming, checks current active worker count against `MAX_CONCURRENT_WORKERS`
  - On claim, spawns a worker process (implementation of the actual worker is out of scope — use a callback/handler interface)
  - Tracks active workers by ID

### FR-5: Heartbeat Mechanism

- Each active worker must periodically refresh a Redis key: `orchestrator:worker:{workerId}:heartbeat`
- TTL: `WORKER_HEARTBEAT_TTL_MS` (default 30000ms)
- The dispatcher runs a reaper loop at `HEARTBEAT_CHECK_INTERVAL_MS` (default 15000ms) that:
  1. Scans for claimed items whose worker heartbeat key has expired
  2. Releases those items back to the pending queue
  3. Logs the stale claim recovery

### FR-6: Queue Depth Query

- Expose a `getQueueDepth()` method returning the count of items in the pending sorted set (`ZCARD`)
- Expose a `getQueueItems(offset, limit)` method for paginated listing (`ZRANGE` with scores)
- Expose an `getActiveWorkerCount()` method returning the number of currently claimed items

### FR-7: Graceful Shutdown

- On shutdown signal, the dispatcher must:
  1. Stop claiming new work
  2. Wait for in-flight workers to complete (with a configurable timeout)
  3. If timeout expires, release remaining claimed items back to the queue
  4. Close Redis connections

## Non-Functional Requirements

- **Atomicity**: Claim operations must be atomic to prevent double-dispatch under concurrent access
- **Latency**: Claim operation should complete within 50ms under normal load
- **Reliability**: Redis connection loss must not crash the process; reconnect automatically (ioredis handles this)
- **Observability**: Structured logging for enqueue, claim, release, complete, heartbeat expiry, and queue depth changes
- **Testability**: Core queue and dispatcher logic must be testable with a real Redis instance (integration tests) and with mocks (unit tests)

## Success Criteria

- [ ] Priority-based ordering via Redis sorted set
- [ ] Atomic claim prevents double-dispatch
- [ ] Concurrency limit enforced
- [ ] Heartbeat TTL auto-releases stale workers
- [ ] Queue depth queryable for dashboard
- [ ] Graceful handling of Redis connection loss

## Out of Scope

- Actual worker process implementation (Claude CLI spawner) — this queue provides the dispatch interface only
- Dashboard UI for queue monitoring (separate issue)
- Multi-instance dispatcher coordination (single-instance for now)
- Queue persistence across Redis restarts (Redis persistence is an ops concern)
- Rate limiting of GitHub API calls within workers

---

*Generated by speckit*
