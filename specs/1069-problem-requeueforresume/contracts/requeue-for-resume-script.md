# Contract: `REQUEUE_FOR_RESUME_SCRIPT`

Atomic read-and-re-pend for lease-expiry events. Preserves `attemptCount` verbatim (lease expiry is infrastructure, not a work failure — FR-003).

## defineCommand registration

```ts
this.redis.defineCommand('requeueForResumeItem', {
  numberOfKeys: 3,
  lua: REQUEUE_FOR_RESUME_SCRIPT,
});
```

Called from `ensureRequeueForResumeCommand()` guard, following the sibling `ensureReclaimOrphanCommand()` pattern at `redis-queue-adapter.ts:243-250`.

## Keys

| Position | Name         | Redis key                                       | Type   |
| -------- | ------------ | ----------------------------------------------- | ------ |
| KEYS[1]  | pending      | `orchestrator:queue:pending`                    | ZSET   |
| KEYS[2]  | claimed hash | `orchestrator:queue:claimed:<workerId>`         | HASH   |
| KEYS[3]  | heartbeat    | `orchestrator:worker:<workerId>:heartbeat`      | STRING |

Under Redis Cluster, all three must hash to the same slot. `RECLAIM_ORPHAN_SCRIPT` already declares the same three keys, so CROSSSLOT safety is inherited by construction (A8).

## Args

| Position | Name           | Type            | Notes                                                                 |
| -------- | -------------- | --------------- | --------------------------------------------------------------------- |
| ARGV[1]  | itemKey        | string          | `<owner>/<repo>#<issue>`                                              |
| ARGV[2]  | resumePriority | number (string) | Client-computed `getPriorityScore('resume')` (A4)                     |
| ARGV[3]  | item JSON      | string          | `JSON.stringify(item)` for base `QueueItem` field reconstruction      |

## Return

Lua array `{code, attemptCount}` — mapped by ioredis to JS `[number, number]`.

| Code | Meaning                                | attemptCount    | Caller action                                          |
| ---- | -------------------------------------- | --------------- | ------------------------------------------------------ |
| 0    | No-op (claim already cleared — reaper race) | `-1` (sentinel) | Log info line at `redis-queue-adapter.ts:853-856`      |
| 1    | Re-pended at resume priority           | Verbatim from claim payload | Log info line at `:879-887` with the returned `attemptCount` |

## Lua body

```lua
local claimed = redis.call('HGET', KEYS[2], ARGV[1])
if not claimed then
  -- Reaper (or another lease-expiry firing) already re-pended it.
  -- Best-effort DEL heartbeat to avoid stale key (matches current TypeScript
  -- fallback at redis-queue-adapter.ts:848-852).
  redis.call('DEL', KEYS[3])
  return {0, -1}
end

local parsed = cjson.decode(claimed)
local base = cjson.decode(ARGV[3])
-- FR-003: attemptCount preserved verbatim — lease expiry is infrastructure,
-- not a work failure. Do NOT increment.
base.queueReason = 'resume'
base.priority = tonumber(ARGV[2])
base.attemptCount = parsed.attemptCount
base.itemKey = ARGV[1]
-- A6: strip claim-lifecycle field so next CLAIM_SCRIPT stamps a fresh one.
base.claimedAt = nil
local repayload = cjson.encode(base)

redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), repayload)

return {1, parsed.attemptCount}
```

## Invariants

- **IN_FLIGHT_KEY membership**: unchanged. Item was in-flight (via claim), item is in-flight (via pending). No `SREM`. (FR-006)
- **attemptCount**: verbatim from the claim payload; NEVER incremented on this path. (FR-003, SC-005)
- **Round-trip count on happy path**: exactly 1 `EVALSHA`. The best-effort `DEL heartbeat` on the no-op branch is inside the script, not a second round trip. (SC-003)
- **Race safety**: `HGET` and the `HDEL + DEL + ZADD` mutation execute atomically on the Redis server. Concurrent `reapOrphanClaims` executions cannot interleave between the read and the mutate. (FR-001)

## Caller shape (`RedisQueueAdapter.requeueForResume`)

```ts
async requeueForResume(workerId: string, item: QueueItem): Promise<void> {
  this.ensureRequeueForResumeCommand();
  const itemKey = buildItemKey(item);
  const claimedKey = buildClaimedKey(workerId);
  const heartbeatKey = buildHeartbeatKey(workerId);
  const resumePriority = getPriorityScore('resume');

  try {
    const [code, attemptCount] = await (this.redis as any).requeueForResumeItem(
      PENDING_KEY,
      claimedKey,
      heartbeatKey,
      itemKey,
      String(resumePriority),
      JSON.stringify(item),
    );
    switch (code) {
      case 0:
        this.logger.info(
          { workerId, itemKey },
          'requeueForResume() called on already-cleared claim (reaper race) — skipping re-pend',
        );
        return;
      case 1:
        this.logger.info(
          { workerId, itemKey, attemptCount, reason: 'lease-expiry' },
          'Item re-pended at resume priority (attemptCount preserved)',
        );
        return;
    }
  } catch (error) {
    this.logger.warn(
      { err: error, workerId, itemKey },
      'Redis error in requeueForResume',
    );
  }
}
```

Log-line messages and field shapes match `redis-queue-adapter.ts:853-856` + `:879-887` verbatim (FR-005 + SC-007).
