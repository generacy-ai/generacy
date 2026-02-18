# Implementation Plan: Redis Queue with Worker Claim and Dispatch

**Feature**: Redis sorted-set queue and worker dispatcher for the orchestrator — replaces the in-memory queue placeholder with production queue infrastructure
**Branch**: `feature/197-redis-queue-dispatch`
**Status**: Complete

## Summary

Replace the in-memory `QueueAdapter` placeholder in `server.ts` (lines 147-155) with a production Redis sorted-set queue and add a `WorkerDispatcher` that polls the queue, enforces concurrency limits, manages worker heartbeats, and recovers stale claims. The queue uses `ZADD` for priority ordering, a Lua script for atomic claim (ZPOPMIN + HSET + heartbeat SET in one round-trip), and exposes depth/status queries for the dashboard.

## Technical Context

- **Language**: TypeScript (ES2022, Node16 modules)
- **Framework**: Fastify 5 (existing server infrastructure)
- **Runtime**: Node.js
- **Dependencies**: `ioredis` (already in package.json), `@generacy-ai/workflow-engine`
- **Test Framework**: Vitest
- **Validation**: Zod schemas
- **Existing patterns**: Service classes with constructor DI, Zod config schemas, Fastify route registration, Redis graceful degradation (see `PhaseTrackerService`)

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── config/
│   │   └── schema.ts                         # MODIFY: Add DispatchConfigSchema
│   ├── services/
│   │   ├── index.ts                          # MODIFY: Export new services
│   │   ├── redis-queue-adapter.ts            # NEW: RedisQueueAdapter (sorted-set queue)
│   │   └── worker-dispatcher.ts              # NEW: WorkerDispatcher (polling + heartbeat)
│   ├── routes/
│   │   └── dispatch.ts                       # NEW: /dispatch/queue routes
│   ├── types/
│   │   ├── monitor.ts                        # MODIFY: Add QueueManager interface
│   │   └── index.ts                          # MODIFY: Export new types
│   ├── server.ts                             # MODIFY: Wire RedisQueueAdapter + WorkerDispatcher
│   └── index.ts                              # MODIFY: Export new public API
├── tests/
│   └── unit/
│       └── services/
│           ├── redis-queue-adapter.test.ts    # NEW: Queue unit tests
│           └── worker-dispatcher.test.ts      # NEW: Dispatcher unit tests
```

## Architecture

### Component Overview

```
LabelMonitorService
        │
        │ enqueue(item)
        ▼
┌─────────────────────────┐
│   RedisQueueAdapter     │
│   (implements QueueManager) │
│                         │
│   ZADD orchestrator:    │
│   queue:pending         │
│   ─────────────────     │
│   claim() → Lua script  │
│   release() → ZADD back │
│   complete() → cleanup  │
└────────┬────────────────┘
         │ claim()
         ▼
┌─────────────────────────┐
│   WorkerDispatcher      │
│                         │
│   Poll loop (5s)        │──→ handler(item) → worker process
│   Reaper loop (15s)     │──→ scan expired heartbeats
│   Concurrency check     │──→ active < MAX_CONCURRENT
│   Graceful shutdown     │──→ wait + release
└─────────────────────────┘
```

### Redis Key Layout

```
orchestrator:queue:pending              # Sorted set (score = priority)
orchestrator:queue:claimed:{workerId}   # Hash (field = itemKey, value = serialized QueueItem)
orchestrator:worker:{workerId}:heartbeat # String with TTL (presence = alive)
```

### Claim Flow (Lua Script)

```
1. ZPOPMIN orchestrator:queue:pending    → get lowest-score item
2. If nil → return nil (queue empty)
3. HSET orchestrator:queue:claimed:{workerId} {itemKey} {serialized}
4. SET orchestrator:worker:{workerId}:heartbeat "1" EX {ttl}
5. Return the claimed item
```

### Key Design Decisions

1. **New `QueueManager` interface extending `QueueAdapter`**: The monitor only uses `enqueue()`. The dispatcher needs `claim`, `release`, `complete`, and query methods. A broader `QueueManager` extends `QueueAdapter` so the monitor injection remains unchanged while the dispatcher gets the full API.

2. **Lua script for atomic claim**: A single Lua script executes ZPOPMIN + HSET + SET atomically in Redis. This prevents double-dispatch without WATCH/MULTI/EXEC retry loops and completes in a single round-trip (~1ms).

3. **Simple async handler callback**: The worker handler is `(item: QueueItem) => Promise<void>`. The dispatcher manages heartbeat refresh externally via `setInterval`, keeping the handler interface simple for future integration with the Claude CLI spawner.

4. **Max 3 retries with dead-letter**: Released items track an `attemptCount` in the serialized payload. After 3 failures the item moves to a dead-letter sorted set and an `agent:failed` label is added to the issue. This prevents poison-message loops.

5. **New `/dispatch/queue` route namespace**: Separate from the existing `/queue` decision routes to avoid confusion. Provides GET depth, GET items, GET workers endpoints for the dashboard.

6. **AbortController for poll/reaper loops**: Same pattern as `LabelMonitorService` — clean cancellation on graceful shutdown.

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `src/services/redis-queue-adapter.ts` | `RedisQueueAdapter` class — enqueue, claim (Lua), release, complete, depth/items/workers queries |
| `src/services/worker-dispatcher.ts` | `WorkerDispatcher` class — poll loop, concurrency enforcement, heartbeat refresh, reaper loop, graceful shutdown |
| `src/routes/dispatch.ts` | Fastify routes: `GET /dispatch/queue/depth`, `GET /dispatch/queue/items`, `GET /dispatch/queue/workers` |
| `tests/unit/services/redis-queue-adapter.test.ts` | Unit tests with mocked Redis |
| `tests/unit/services/worker-dispatcher.test.ts` | Unit tests with mocked queue adapter |

### Modified Files

| File | Change |
|------|--------|
| `src/types/monitor.ts` | Add `QueueManager` interface extending `QueueAdapter` with claim/release/complete/query methods; add `WorkerHandle` type |
| `src/types/index.ts` | Export new types |
| `src/config/schema.ts` | Add `DispatchConfigSchema` (poll interval, max workers, heartbeat TTL, shutdown timeout) |
| `src/services/index.ts` | Export `RedisQueueAdapter`, `WorkerDispatcher` |
| `src/server.ts` | Replace in-memory adapter (lines 147-155) with `RedisQueueAdapter`; instantiate `WorkerDispatcher`; add to shutdown cleanup |
| `src/routes/index.ts` | Register dispatch routes |
| `src/index.ts` | Export new public API |

## Implementation Order

1. **Config schema** — add `DispatchConfigSchema` to `schema.ts`
2. **Type definitions** — add `QueueManager` interface and related types to `monitor.ts`
3. **RedisQueueAdapter** — implement queue operations with Lua claim script
4. **WorkerDispatcher** — implement poll loop, heartbeat management, reaper, shutdown
5. **Dispatch routes** — Fastify routes for queue status queries
6. **Server integration** — wire adapter + dispatcher into `server.ts`, replace placeholder
7. **Tests** — unit tests for adapter and dispatcher

## Dependencies

- `ioredis` — Redis client (already in package.json)
- No new external dependencies required

## Configuration

```json
{
  "dispatch": {
    "pollIntervalMs": 5000,
    "maxConcurrentWorkers": 3,
    "heartbeatTtlMs": 30000,
    "heartbeatCheckIntervalMs": 15000,
    "shutdownTimeoutMs": 60000,
    "maxRetries": 3
  }
}
```

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Redis unavailable at startup | Graceful degradation — log warning, retry on next poll cycle (same pattern as `PhaseTrackerService`) |
| Lua script compatibility | Use basic Redis commands (ZPOPMIN, HSET, SET) available since Redis 5.0; test with CI Redis |
| Worker handler blocks indefinitely | Heartbeat TTL expiry triggers reaper; dispatcher doesn't await handler beyond heartbeat window |
| Priority inversion with retries | Released items preserve original priority score; dead-letter after 3 attempts prevents starvation |
| Race condition in concurrent dispatchers | Single-instance design (out of scope for multi-instance); Lua atomicity prevents double-claim |

---

*Generated by speckit*
