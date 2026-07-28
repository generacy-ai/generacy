# Contract: `RELEASE_SCRIPT`

Atomic read-and-re-pend (retry branch) OR read-and-dead-letter (max-retries branch). Both branches folded into a single Lua script per Clarifications Q1 → A so SC-004 is satisfied on both.

## defineCommand registration

```ts
this.redis.defineCommand('releaseItem', {
  numberOfKeys: 5,
  lua: RELEASE_SCRIPT,
});
```

Called from `ensureReleaseCommand()` guard, following the sibling `ensureReclaimOrphanCommand()` pattern.

## Keys

| Position | Name          | Redis key                                       | Type   |
| -------- | ------------- | ----------------------------------------------- | ------ |
| KEYS[1]  | pending       | `orchestrator:queue:pending`                    | ZSET   |
| KEYS[2]  | claimed hash  | `orchestrator:queue:claimed:<workerId>`         | HASH   |
| KEYS[3]  | heartbeat     | `orchestrator:worker:<workerId>:heartbeat`      | STRING |
| KEYS[4]  | dead-letter   | `orchestrator:queue:dead-letter`                | ZSET   |
| KEYS[5]  | in-flight SET | `orchestrator:queue:in-flight-items`            | SET    |

Under Redis Cluster, all five must hash to the same slot (A8). This extends `RECLAIM_ORPHAN_SCRIPT`'s known-safe three-key set with two additional keys of the same shape.

## Args

| Position | Name          | Type            | Notes                                                                    |
| -------- | ------------- | --------------- | ------------------------------------------------------------------------ |
| ARGV[1]  | itemKey       | string          | `<owner>/<repo>#<issue>`                                                 |
| ARGV[2]  | retryPriority | number (string) | Client-computed `getPriorityScore('retry')` (A4)                         |
| ARGV[3]  | item JSON     | string          | `JSON.stringify(item)` for base `QueueItem` field reconstruction         |
| ARGV[4]  | maxRetries    | number (string) | Client-side threshold; script dispatches dead-letter at `>=` (FR-004)    |
| ARGV[5]  | nowMs         | number (string) | `Date.now()` — ZADD score for the dead-letter entry (matches current `Date.now()` at `redis-queue-adapter.ts:774`) |

## Return

Lua array `{code, attemptCount}` — mapped by ioredis to JS `[number, number]`.

| Code | Meaning                                | attemptCount               | Caller action                                              |
| ---- | -------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| 0    | No-op (claim already cleared — reaper race) | `-1` (sentinel)      | Log info line at `redis-queue-adapter.ts:753-756`          |
| 1    | Retry re-pended                        | `parsed.attemptCount + 1`  | Log info line at `:802-805` with the returned `attemptCount` |
| 2    | Dead-lettered                          | `parsed.attemptCount + 1`  | Log warn line at `:782-785` with the returned `attemptCount` + `maxRetries`; caller clears `dropLogState` and `enqueuedAtCache` for the itemKey |

## Lua body

```lua
local claimed = redis.call('HGET', KEYS[2], ARGV[1])
if not claimed then
  -- Another actor (reaper or another release firing) already re-pended it.
  -- Skipping the re-pend avoids a duplicate pending member (spec §Summary).
  -- Best-effort DEL heartbeat (matches current TypeScript fallback at
  -- redis-queue-adapter.ts:748-752).
  redis.call('DEL', KEYS[3])
  return {0, -1}
end

local parsed = cjson.decode(claimed)
local attemptCount = parsed.attemptCount + 1  -- FR-004: +1 on the retry side
local maxRetries = tonumber(ARGV[4])
local base = cjson.decode(ARGV[3])
base.attemptCount = attemptCount
base.itemKey = ARGV[1]
-- A6: strip claim-lifecycle field for parity with the retry re-pend path.
base.claimedAt = nil

if attemptCount >= maxRetries then
  -- FR-002 Q1=A: dead-letter branch folded into the same script.
  -- FR-006: SREM IN_FLIGHT_KEY fires ONLY on this branch.
  local dlpayload = cjson.encode(base)
  redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('DEL', KEYS[3])
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), dlpayload)
  redis.call('SREM', KEYS[5], ARGV[1])
  return {2, attemptCount}
end

-- Retry branch. IN_FLIGHT_KEY membership PRESERVED (no SREM — FR-006).
base.queueReason = 'retry'
base.priority = tonumber(ARGV[2])
local repayload = cjson.encode(base)
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), repayload)

return {1, attemptCount}
```

## Invariants

- **IN_FLIGHT_KEY on retry branch (code 1)**: preserved. Item was in-flight (via claim), item is in-flight (via pending). No `SREM`. (FR-006)
- **IN_FLIGHT_KEY on dead-letter branch (code 2)**: removed via `SREM`. Item was in-flight, item is now permanently in dead-letter. Matches current behaviour at `redis-queue-adapter.ts:775`. (FR-006)
- **IN_FLIGHT_KEY on no-op branch (code 0)**: untouched. Whichever concurrent actor won the race is responsible for the invariant on their branch.
- **attemptCount**: post-mutation value returned on codes 1 and 2. Sentinel `-1` on code 0 — caller does not log this field on the no-op branch (matches current behaviour where the null-guard skips the attempt-count log entirely). (FR-005)
- **Round-trip count on happy path (both branches)**: exactly 1 `EVALSHA`. (SC-004)
- **Race safety**: `HGET` and the entire mutation sequence execute atomically. Concurrent `reapOrphanClaims` cannot interleave. (FR-002)
- **Dead-letter dispatch threshold**: `attemptCount + 1 >= maxRetries` (script-side computation matches current TypeScript at `redis-queue-adapter.ts:763`). (FR-004)

## Caller shape (`RedisQueueAdapter.release`)

```ts
async release(workerId: string, item: QueueItem): Promise<void> {
  this.ensureReleaseCommand();
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);
  const retryPriority = getPriorityScore('retry');

  try {
    const [code, attemptCount] = await (this.redis as any).releaseItem(
      PENDING_KEY,
      claimedKey,
      heartbeatKey,
      DEAD_LETTER_KEY,
      IN_FLIGHT_KEY,
      itemKey,
      String(retryPriority),
      JSON.stringify(item),
      String(this.maxRetries),
      String(Date.now()),
    );
    switch (code) {
      case 0:
        this.logger.info(
          { workerId, itemKey },
          'release() called on already-cleared claim (reaper race) — skipping re-pend to avoid duplicate pending member',
        );
        return;
      case 1:
        this.logger.info(
          { workerId, itemKey, attemptCount },
          'Item released back to pending queue',
        );
        return;
      case 2:
        // #1054 / R6 + #1054 finding 7 bookkeeping cleanup — script preserves
        // the SREM invariant; caller preserves the in-memory Map cleanup.
        this.dropLogState.delete(itemKey);
        this.enqueuedAtCache.delete(itemKey);
        this.logger.warn(
          { workerId, itemKey, attemptCount, maxRetries: this.maxRetries },
          'Item dead-lettered after max retries',
        );
        return;
    }
  } catch (error) {
    this.logger.warn(
      { err: error, workerId, itemKey },
      'Redis error in release',
    );
  }
}
```

Log-line messages and field shapes match `redis-queue-adapter.ts:753-756` + `:782-785` + `:802-805` verbatim (FR-005 + SC-007).
