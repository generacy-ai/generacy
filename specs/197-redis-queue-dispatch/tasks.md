# Tasks: Redis Queue with Worker Claim and Dispatch

**Input**: Design documents from `/specs/197-redis-queue-dispatch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Configuration & Type Definitions

- [ ] T001 [US1] Add `DispatchConfigSchema` to `packages/orchestrator/src/config/schema.ts` — define `pollIntervalMs`, `maxConcurrentWorkers`, `heartbeatTtlMs`, `heartbeatCheckIntervalMs`, `shutdownTimeoutMs`, `maxRetries` with Zod validation; add `dispatch` field to `OrchestratorConfigSchema`
- [ ] T002 [P] [US1] Add `QueueManager` interface and supporting types to `packages/orchestrator/src/types/monitor.ts` — extend `QueueAdapter` with `claim`, `release`, `complete`, `getQueueDepth`, `getQueueItems`, `getActiveWorkerCount`; add `QueueItemWithScore`, `SerializedQueueItem`, `WorkerHandler` types
- [ ] T003 [P] [US1] Export new types from `packages/orchestrator/src/types/index.ts`

## Phase 2: Core Queue Implementation

- [ ] T004 [US1] [US2] Create `packages/orchestrator/src/services/redis-queue-adapter.ts` — implement `RedisQueueAdapter` class:
  - Constructor accepting Redis client and logger (same DI pattern as `PhaseTrackerService`)
  - `enqueue(item)`: serialize with `attemptCount: 0`, `ZADD` to pending sorted set
  - Lua script for atomic claim: `ZPOPMIN` + `HSET` claimed hash + `SET` heartbeat with TTL
  - `claim(workerId)`: execute Lua script, deserialize result or return null
  - `release(workerId, item)`: increment `attemptCount`, check against `maxRetries`; if exceeded move to dead-letter set, otherwise `ZADD` back to pending; `HDEL` from claimed hash; `DEL` heartbeat key
  - `complete(workerId, item)`: `HDEL` from claimed hash, `DEL` heartbeat key
  - `getQueueDepth()`: `ZCARD` on pending set
  - `getQueueItems(offset, limit)`: `ZRANGE` with `WITHSCORES`, deserialize
  - `getActiveWorkerCount()`: count via `HLEN` across claimed hashes or track in a Redis set
  - Graceful degradation: log warnings on Redis errors, don't crash

## Phase 3: Worker Dispatcher

- [ ] T005 [US3] [US4] Create `packages/orchestrator/src/services/worker-dispatcher.ts` — implement `WorkerDispatcher` class:
  - Constructor accepting `QueueManager`, logger, `DispatchConfig`, and `WorkerHandler` callback
  - `start()`: begin poll loop and reaper loop using `AbortController`
  - Poll loop: check `activeWorkers.size < maxConcurrentWorkers`, call `queue.claim(workerId)`, wrap handler with heartbeat refresh interval (`setInterval` at TTL/2), track in `activeWorkers` Map
  - Reaper loop: iterate tracked worker IDs, check heartbeat key existence, release items with expired heartbeats
  - `stop()`: abort controller, wait for in-flight workers with shutdown timeout, release remaining claimed items
  - Worker completion callback: call `queue.complete()`, clean up heartbeat interval, remove from `activeWorkers`
  - Worker failure callback: call `queue.release()`, clean up, log error

## Phase 4: Routes & Server Integration

- [ ] T006 [US5] Create `packages/orchestrator/src/routes/dispatch.ts` — Fastify route plugin:
  - `GET /dispatch/queue/depth` → call `queue.getQueueDepth()`, return `{ depth: number }`
  - `GET /dispatch/queue/items?offset=0&limit=10` → call `queue.getQueueItems()`, return paginated items with scores
  - `GET /dispatch/queue/workers` → call `queue.getActiveWorkerCount()`, return `{ count: number }`
  - Zod schemas for query parameters
- [ ] T007 [P] [US1] Update `packages/orchestrator/src/services/index.ts` — export `RedisQueueAdapter` and `WorkerDispatcher`
- [ ] T008 [P] [US1] Update `packages/orchestrator/src/index.ts` — export new public API types and services
- [ ] T009 [US1] [US3] Modify `packages/orchestrator/src/server.ts` — replace in-memory queue adapter (lines 147-155) with `RedisQueueAdapter`; instantiate `WorkerDispatcher` with a placeholder handler; start dispatcher in `onReady` hook; add dispatcher stop + Redis cleanup to graceful shutdown
- [ ] T010 [US5] Update `packages/orchestrator/src/routes/index.ts` — register dispatch routes, pass `QueueManager` instance

## Phase 5: Tests

- [ ] T011 [US2] Create `packages/orchestrator/tests/unit/services/redis-queue-adapter.test.ts`:
  - Mock ioredis client
  - Test enqueue adds to sorted set with correct score
  - Test claim returns deserialized item and sets heartbeat
  - Test claim returns null when queue empty
  - Test release increments attemptCount and re-queues
  - Test release dead-letters after maxRetries
  - Test complete removes claimed item and heartbeat
  - Test getQueueDepth returns ZCARD result
  - Test getQueueItems returns paginated results
  - Test graceful degradation on Redis errors
- [ ] T012 [P] [US3] [US4] Create `packages/orchestrator/tests/unit/services/worker-dispatcher.test.ts`:
  - Mock QueueManager
  - Test poll loop claims and dispatches to handler
  - Test concurrency limit enforcement (doesn't claim when at max)
  - Test heartbeat refresh calls SET with TTL
  - Test reaper releases items with expired heartbeats
  - Test graceful shutdown waits for in-flight workers
  - Test graceful shutdown releases remaining items on timeout
  - Test handler failure triggers release (not complete)

## Dependencies & Execution Order

```
T001 ─┐
T002 ─┤── Phase 1 (parallel: T002, T003)
T003 ─┘
  │
  ▼
T004 ── Phase 2 (depends on T001 for config, T002 for types)
  │
  ▼
T005 ── Phase 3 (depends on T004 for QueueManager)
  │
  ▼
T006 ─┐
T007 ─┤
T008 ─┤── Phase 4 (T007/T008 parallel; T006/T009/T010 sequential)
T009 ─┤
T010 ─┘
  │
  ▼
T011 ─┐── Phase 5 (T011/T012 parallel)
T012 ─┘
```

**Parallel opportunities**:
- T002 + T003 can run in parallel within Phase 1
- T007 + T008 can run in parallel within Phase 4
- T011 + T012 can run in parallel within Phase 5

**Critical path**: T001 → T004 → T005 → T009 → T011

---

*Generated by speckit*
