# Data Model: RedisQueueAdapter.enqueue() in-flight-SET invariant

## Interface change: `QueueAdapter.enqueue`

**File**: `packages/orchestrator/src/types/monitor.ts` line ~229–231.

```ts
// BEFORE
export interface QueueAdapter {
  enqueue(item: QueueItem): Promise<void>;
}

// AFTER
export interface QueueAdapter {
  /**
   * Atomically enqueue an item, dropping if its `itemKey` is already
   * in flight (pending or claimed by any worker).
   *
   * Invariant: after `enqueue(item)` returns `true`, `item.itemKey` MUST
   * be a member of the in-flight index (`orchestrator:queue:in-flight-items`
   * on the Redis adapter, `inFlightSet` on the in-memory adapter). Every
   * implementation of this interface is bound to the invariant equality
   * `in-flight = pending ∪ claimed` at every intermediate step of the
   * `enqueue → claim → release-retry → reclaim-orphan → complete` sequence.
   *
   * @returns true if enqueued, false if dropped (already in flight or
   *          transport error).
   */
  enqueue(item: QueueItem): Promise<boolean>;
}
```

## Interface change: `QueueManager.enqueue`

**File**: `packages/orchestrator/src/types/monitor.ts` line ~284 (via inheritance from `QueueAdapter`). No local declaration on `QueueManager` — the inherited signature changes automatically once `QueueAdapter` is updated.

## Lua script contract: `ENQUEUE_SCRIPT`

**File**: `packages/orchestrator/src/services/redis-queue-adapter.ts` — new constant added alongside the four existing script constants.

**Keys**:

| Position | Name           | Redis key                                | Type      |
| -------- | -------------- | ---------------------------------------- | --------- |
| KEYS[1]  | pending        | `orchestrator:queue:pending`             | Sorted Set |
| KEYS[2]  | in-flight SET  | `orchestrator:queue:in-flight-items`     | Set       |
| KEYS[3]  | dedup marker   | `orchestrator:queue:_dedup:<itemKey>`    | Hash *(D6-b: omitted; D6-a: present)* |

**Args**:

| Position | Name        | Type            | Notes                                                    |
| -------- | ----------- | --------------- | -------------------------------------------------------- |
| ARGV[1]  | itemKey     | string          | `<owner>/<repo>#<issue>`                                 |
| ARGV[2]  | priority    | number (string) | `getPriorityScore(item.queueReason)`                     |
| ARGV[3]  | member JSON | string          | `JSON.stringify(SerializedQueueItem)`                    |

**Return codes**: identical to `ENQUEUE_IF_ABSENT_SCRIPT`.

| Value | Meaning              | Caller mapping   |
| ----- | -------------------- | ---------------- |
| `1`   | enqueued             | `return true`    |
| `0`   | already in-flight    | `return false` + `emitDropLog` |

**Lua body (D6-b — recommended)**:

```lua
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
```

Note: this is byte-identical to `ENQUEUE_IF_ABSENT_SCRIPT`. That is intentional — the two verbs' *scripts* are the same; they differ only in how the caller reads the boolean. See `research.md § Decision 2`.

**Lua body (D6-a — strict FR-001 compliance, adds `_dedup` write)**:

```lua
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
redis.call('HSET', KEYS[3], 'member', ARGV[3])
return 1
```

If D6-a is chosen, corresponding `redis.call('DEL', ...)` for `orchestrator:queue:_dedup:<itemKey>` must be added inside `RECLAIM_ORPHAN_SCRIPT`'s reclaim branch, `RELEASE_SCRIPT`'s dead-letter branch, and `complete()`'s `.multi()` chain. This expands FR-004's "additive to `enqueue()` only" scope. Recommendation: use D6-b unless reviewer requests D6-a; see `research.md § Decision 6`.

## Log line schema (adapter-side, FR-005)

Emitted from `RedisQueueAdapter.enqueue()` on `result === 0` **and** `InMemoryQueueAdapter.enqueue()` on dedupe hit.

**Fields**:

| Field       | Type                          | Source                                                      |
| ----------- | ----------------------------- | ----------------------------------------------------------- |
| `itemKey`   | string                        | `<owner>/<repo>#<issueNumber>`                              |
| `source`    | `'enqueue' \| 'enqueueIfAbsent'` | Constant per call site (`'enqueue'` for both new sites)     |
| `reason`    | `'in-flight'`                 | Constant                                                    |
| `ageMs`     | `number \| null`              | `hasInFlightAge(itemKey)` at call time; `null` on transport error |
| `severity`  | `'info' \| 'warn'`            | Attached by `emitDropLog` on transition edges only          |

**Message**: `Dropping enqueue (item already in flight)` — matches the existing `enqueueIfAbsent` drop message verbatim.

**Emission**: via `emitDropLog(logger, classifyDropSeverity(...), payload, message)` — mirrors `redis-queue-adapter.ts:265-277`. Transition-edge throttling from `drop-log-helper.ts` is inherited for free.

## `SerializedQueueItem` (unchanged)

**File**: `packages/orchestrator/src/types/monitor.ts:244-277`. No fields added or removed. Serialization is the JSON `member` string added to the ZSET.

## `hasInFlight` / `hasInFlightAge` (unchanged)

Existing public methods on `RedisQueueAdapter` and `InMemoryQueueAdapter`. Called by the new `enqueue()` drop path to populate `ageMs` in the log line. Not part of the dedupe gate.

## Redis keyspace (unchanged)

| Key                                        | Type        | Owner writes                                                    | Owner reads                                   |
| ------------------------------------------ | ----------- | --------------------------------------------------------------- | --------------------------------------------- |
| `orchestrator:queue:pending`               | ZSET        | ENQUEUE_SCRIPT (new), ENQUEUE_IF_ABSENT_SCRIPT, RELEASE_SCRIPT, RECLAIM_ORPHAN_SCRIPT | CLAIM_SCRIPT, `getQueueDepth`, `getQueueItems`, `hasInFlightAge` |
| `orchestrator:queue:in-flight-items`       | SET         | ENQUEUE_SCRIPT (new), ENQUEUE_IF_ABSENT_SCRIPT, `release()` dead-letter, `complete()` | `hasInFlight`, `hasInFlightAge`, ENQUEUE_SCRIPT + ENQUEUE_IF_ABSENT_SCRIPT (SISMEMBER guard) |
| `orchestrator:queue:claimed:<workerId>`    | HASH        | CLAIM_SCRIPT, `release()`, `complete()`, RECLAIM_ORPHAN_SCRIPT   | `reapOrphanClaims`, `getActiveWorkerCount`, `hasInFlightAge` |
| `orchestrator:worker:<workerId>:heartbeat` | STRING (EX) | CLAIM_SCRIPT, dispatcher heartbeat                              | RECLAIM_ORPHAN_SCRIPT, `reapOrphanClaims`     |
| `orchestrator:queue:dead-letter`           | ZSET        | `release()` dead-letter branch                                  | (external)                                    |
| `orchestrator:queue:_dedup:<itemKey>`      | HASH        | (D6-a only — net-new; see `research.md § Decision 6`)           | (no consumer today)                            |

## Validation rules

- **`enqueue()` acceptance test invariant**: post-condition `SISMEMBER IN_FLIGHT_KEY item.itemKey === 1` MUST hold whenever `enqueue()` returns `true`.
- **`enqueue()` idempotence test invariant**: a repeated `enqueue({...same})` call MUST return `false`, MUST NOT add a second ZSET member, MUST NOT re-emit `SADD` (script early-exits at `SISMEMBER === 1`).
- **Interface parity**: both `InMemoryQueueAdapter` and `RedisQueueAdapter` return the same boolean for identical input sequences and emit log lines with identical field shapes (SC-003).
- **End-to-end invariant**: at every intermediate step of `enqueue → claim → release-retry → reclaim-orphan → complete`, the set equality `in-flight-items == pending-keys ∪ claimed-keys` holds. Enforced by FR-007's parameterized regression test.

## Relationships between entities

```
QueueItem (in) ──► SerializedQueueItem (JSON member) ──► pending ZSET
                                                    ├─► in-flight SET  (via SADD in ENQUEUE_SCRIPT)
                                                    └─► [_dedup:<itemKey> HASH]  (D6-a only)

CLAIM_SCRIPT: pending ZSET ──► claimed:<workerId> HASH  (in-flight SET unchanged — invariant)

release(retry): claimed:<workerId> HASH ──► pending ZSET  (in-flight SET unchanged)
release(dead-letter): claimed:<workerId> HASH ──► dead-letter ZSET  (SREM in-flight)
complete(): claimed:<workerId> HASH ──► ∅  (SREM in-flight)

reapOrphanClaims: claimed:<workerId> HASH ──► pending ZSET  (in-flight SET unchanged — RECLAIM_ORPHAN_SCRIPT does not SREM)
```

All arrows are atomic per-operation (`.multi()` chains for `release`/`complete`; single Lua script for `enqueue`/`claim`/`reclaim`).
