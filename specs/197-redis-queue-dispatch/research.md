# Research: Redis Queue with Worker Claim and Dispatch

## Technology Decisions

### 1. Lua Script for Atomic Claim

**Decision**: Use a single Lua script to atomically ZPOPMIN + HSET + SET heartbeat in one Redis round-trip.

**Rationale**: Lua scripts in Redis execute atomically — no other command can interleave. This guarantees that if two dispatchers (or future multi-instance setups) call claim simultaneously, each gets a different item or nil. A single round-trip also keeps latency under 5ms versus 3 round-trips for WATCH/MULTI/EXEC.

**Alternative considered**: WATCH/MULTI/EXEC transaction. Rejected because optimistic locking requires retry loops under contention, adding complexity and latency. The Lua approach is simpler and deterministic.

### 2. QueueManager Extends QueueAdapter

**Decision**: Create a new `QueueManager` interface that extends `QueueAdapter` (which only has `enqueue`). The broader interface adds `claim`, `release`, `complete`, `getQueueDepth`, `getQueueItems`, and `getActiveWorkerCount`.

**Rationale**: The `LabelMonitorService` only needs `enqueue()` and already depends on `QueueAdapter`. Extending rather than modifying preserves backward compatibility — the monitor receives a `QueueManager` instance but only sees the `QueueAdapter` subset. The dispatcher and routes use the full `QueueManager` interface.

**Alternative considered**: Adding all methods directly to `QueueAdapter`. Rejected because it would force the monitor to depend on methods it doesn't use, violating interface segregation.

### 3. Simple Async Handler Callback

**Decision**: Worker handler signature is `(item: QueueItem) => Promise<void>`. The dispatcher manages heartbeat refresh externally.

**Rationale**: The actual worker implementation (Claude CLI spawner) is out of scope. A simple async function is the easiest contract to implement and test. The dispatcher wraps the handler call with a `setInterval` that refreshes the heartbeat key, so the handler doesn't need to know about Redis.

**Alternative considered**: (B) Returning a `{ promise, cancel }` handle — adds complexity without benefit since the dispatcher already controls lifecycle. (C) Event-based `WorkerProcess` — over-engineered for the current single-instance design.

### 4. Dead-Letter After 3 Retries

**Decision**: Track `attemptCount` in the serialized queue item. After 3 release cycles, move the item to `orchestrator:queue:dead-letter` sorted set and add `agent:failed` label to the GitHub issue.

**Rationale**: Without a retry limit, a consistently failing item would be claimed and released indefinitely, blocking other work. The dead-letter set preserves failed items for inspection without polluting the active queue. The `agent:failed` label makes failures visible in GitHub.

**Alternative considered**: (A) No retry limit — simple but risks queue starvation. (C) Exponential backoff on priority — complex to implement and reason about, and doesn't prevent indefinite retries.

### 5. Separate `/dispatch/queue` Route Namespace

**Decision**: New route namespace `/dispatch/queue` with GET depth, GET items, GET workers endpoints. Not under the existing `/queue` namespace.

**Rationale**: The existing `/queue` routes serve the decision queue (approval/choice/input/review decisions), which is a fundamentally different system. Sharing a namespace would cause confusion and coupling. The `/dispatch` prefix clearly indicates this is the workflow dispatch queue.

**Alternative considered**: (B) No HTTP API — rejected because dashboard monitoring is a stated requirement. (C) Sub-path `/queue/dispatch` — rejected to avoid ambiguity with the parent `/queue` resource.

### 6. AbortController-Based Loop Cancellation

**Decision**: Use `AbortController` for both the poll loop and the reaper loop, matching the pattern established by `LabelMonitorService`.

**Rationale**: Consistency with the existing codebase. `AbortController.abort()` cleanly cancels pending `setTimeout` waits without leaving dangling timers. The signal can be checked between iterations for immediate exit.

## Implementation Patterns

### Lua Script Loading

Load the claim Lua script once via `redis.defineCommand()` (ioredis custom commands) rather than calling `EVAL` each time. This registers the script server-side and uses EVALSHA for subsequent calls, reducing bandwidth.

```typescript
// Register custom command once
redis.defineCommand('claimItem', {
  numberOfKeys: 3,
  lua: CLAIM_SCRIPT,
});

// Call as a method
const result = await (redis as any).claimItem(
  'orchestrator:queue:pending',
  `orchestrator:queue:claimed:${workerId}`,
  `orchestrator:worker:${workerId}:heartbeat`,
  heartbeatTtlSeconds
);
```

### Heartbeat Refresh Pattern

The dispatcher wraps each handler invocation with a heartbeat interval:

```typescript
const interval = setInterval(async () => {
  await redis.set(heartbeatKey, '1', 'EX', ttlSeconds);
}, ttlMs / 2); // Refresh at half the TTL

try {
  await handler(item);
} finally {
  clearInterval(interval);
}
```

### Reaper Scan Pattern

The reaper iterates over known worker IDs (tracked in a Redis set or in-memory) and checks heartbeat key existence:

```typescript
for (const workerId of activeWorkerIds) {
  const alive = await redis.exists(`orchestrator:worker:${workerId}:heartbeat`);
  if (!alive) {
    await queue.release(workerId, item);
    activeWorkerIds.delete(workerId);
  }
}
```

## References

- [Redis ZADD documentation](https://redis.io/commands/zadd/)
- [Redis ZPOPMIN documentation](https://redis.io/commands/zpopmin/)
- [Redis Lua scripting](https://redis.io/docs/interact/programmability/eval-intro/)
- [ioredis custom commands](https://github.com/redis/ioredis#lua-scripting)
- [ioredis documentation](https://github.com/redis/ioredis)

---

*Generated by speckit*
