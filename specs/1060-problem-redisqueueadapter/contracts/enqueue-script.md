# Contract: `ENQUEUE_SCRIPT` (Lua)

**Location**: string constant in `packages/orchestrator/src/services/redis-queue-adapter.ts`.
**Registered**: via `redis.defineCommand('enqueueItem', { numberOfKeys: 3, lua: ENQUEUE_SCRIPT })` behind an `ensureEnqueueCommand()` guard.
**Invoked**: `RedisQueueAdapter.enqueue()`.

## Keys

| Position | Redis key                                | Type     |
| -------- | ---------------------------------------- | -------- |
| KEYS[1]  | `orchestrator:queue:pending`             | ZSET     |
| KEYS[2]  | `orchestrator:queue:in-flight-items`     | SET      |
| KEYS[3]  | `orchestrator:queue:_dedup:<itemKey>`    | HASH — passed but written only under D6-a; see `data-model.md` |

## Args

| Position | Name        | Type            |
| -------- | ----------- | --------------- |
| ARGV[1]  | itemKey     | string          |
| ARGV[2]  | priority    | numeric string  |
| ARGV[3]  | member JSON | string          |

## Preconditions

1. Caller has constructed a `SerializedQueueItem` with `itemKey`, `priority`, `attemptCount = 0`, and all `QueueItem` base fields populated.
2. Caller has called `getPriorityScore(item.queueReason)` and stringified it for ARGV[2].
3. `ensureEnqueueCommand()` has been invoked at least once (idempotent guard).

## Postconditions on `return 1` (enqueued)

- `SISMEMBER KEYS[2] ARGV[1]` returns 1.
- `ZCARD KEYS[1]` has been incremented by exactly 1 (unless the caller had a pre-existing member with an identical member-string, which is impossible on the enqueue path since `attemptCount = 0` and `enqueuedAt` is per-call).
- Caller: sets `enqueuedAtCache.set(itemKey, Date.parse(item.enqueuedAt))` and logs at `info` with `'Item enqueued to Redis sorted set (in-flight-checked)'`.

## Postconditions on `return 0` (already in flight)

- Zero mutation. No `SADD`, no `ZADD`, no `HSET`.
- `SISMEMBER KEYS[2] ARGV[1]` still returns 1 (it was already 1; script early-exited).
- `ZCARD KEYS[1]` unchanged.
- Caller: calls `hasInFlightAge(itemKey)` to compute `ageMs`, calls `classifyDropSeverity(itemKey, ageMs, maxRunDurationMs, dropLogState)`, calls `emitDropLog(logger, decision, { itemKey, source: 'enqueue', reason: 'in-flight', ageMs }, 'Dropping enqueue (item already in flight)')`.
- Caller: returns `false` from `enqueue()`.

## Invariants

- **Atomicity**: `SISMEMBER` and `SADD`+`ZADD` execute in the same Lua invocation. No client between the two operations can observe the SET member without the pending entry (or vice versa).
- **Race safety**: two concurrent calls with identical `ARGV[1]` — one returns 1 (the winner), the other returns 0. Redis single-threaded Lua execution guarantees this without additional locking.
- **No side-effects on drop**: the `return 0` branch touches no keys.
- **Non-modification of `CLAIM_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `release()`, `complete()`**: this script is additive per FR-004.

## Return codes

| Value | Meaning              |
| ----- | -------------------- |
| `1`   | Enqueued (new pending + SET member; caller returns `true`) |
| `0`   | Already in flight (no mutation; caller emits drop log + returns `false`) |

## Test hooks

- Real-Redis test asserts: `enqueue({ itemKey: k })` → `SISMEMBER IN_FLIGHT_KEY k === 1`.
- Real-Redis test asserts: `enqueue({ itemKey: k })` then `enqueue({ itemKey: k })` — second returns `false`, `ZCARD PENDING_KEY === 1`, `SCARD IN_FLIGHT_KEY === 1`.
- Real-Redis test asserts: deleting the `SADD KEYS[2]` line from `ENQUEUE_SCRIPT` produces a test failure (SC-006).

## Composition with `RECLAIM_ORPHAN_SCRIPT` (#1054 / PR #1056)

`RECLAIM_ORPHAN_SCRIPT` intentionally does **not** `SREM` the in-flight SET when moving an orphaned claim back to pending (`redis-queue-adapter.ts:82-90`). Its correctness depends on the item having been added to the SET at enqueue time. Before this spec, that premise held only for items enqueued via `enqueueIfAbsent`; after this spec, it holds for items enqueued via `enqueue` too. The composition is proved by FR-007's `enqueue → claim → release-retry → reclaim-orphan → complete` invariant test.
