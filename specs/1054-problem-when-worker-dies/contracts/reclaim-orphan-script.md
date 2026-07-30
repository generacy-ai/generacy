# Contract — `RECLAIM_ORPHAN_SCRIPT`

Load-bearing invariant for FR-004, US2 (race safety), and FR-005 (grace window).

## Wire shape

```lua
-- KEYS[1] = orchestrator:queue:claimed:<workerId>
-- KEYS[2] = orchestrator:worker:<workerId>:heartbeat
-- KEYS[3] = orchestrator:queue:in-flight-items
-- KEYS[4] = orchestrator:queue:pending
-- ARGV[1] = itemKey
-- ARGV[2] = workerId (opaque; for logging inference only, unused in script body)
-- ARGV[3] = now (epoch-ms, string)
-- ARGV[4] = graceWindowMs (string)
-- ARGV[5] = resumePriority (string; getPriorityScore('resume') = "0")
-- ARGV[6] = reclaimItemJSON (pre-serialized SerializedQueueItem with attemptCount++,
--           queueReason='resume', preserved enqueuedAt + metadata)

-- Return codes:
--   0 = no-op (nothing to reclaim; claim hash field absent)
--   1 = reclaimed
--   2 = heartbeat re-appeared server-side (US2 abort)
--   3 = within grace window (FR-005 abort)

local claimed = redis.call('HGET', KEYS[1], ARGV[1])
if not claimed then
  return 0
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end

local parsed = cjson.decode(claimed)
-- parsed.enqueuedAt is ISO-8601; Lua on Redis has no strptime. We embed
-- the age comparison as (now - enqueuedAtMs). enqueuedAtMs is passed
-- pre-parsed by the client via a separate ARGV, but since the payload
-- already has enqueuedAt in JSON we parse it out client-side and compare
-- against `now` client-side is impossible under Lua atomicity. So we pass
-- ageMs directly in a supplementary ARGV — see the actual final contract
-- below.

return 1
```

**Correction to the sketch above.** Lua on Redis cannot parse ISO-8601 timestamps without a helper. The final contract passes `ageMs` directly (client-computed) rather than `now`, and moves the grace comparison to a direct integer subtraction:

## Final contract

```lua
-- KEYS[1] = orchestrator:queue:claimed:<workerId>
-- KEYS[2] = orchestrator:worker:<workerId>:heartbeat
-- KEYS[3] = orchestrator:queue:in-flight-items
-- KEYS[4] = orchestrator:queue:pending
-- ARGV[1] = itemKey
-- ARGV[2] = ageMs (client-computed: now - Date.parse(claimed.enqueuedAt))
-- ARGV[3] = graceWindowMs
-- ARGV[4] = resumePriority (numeric string; "0" for 'resume')
-- ARGV[5] = reclaimItemJSON

-- 0 = no-op (nothing to reclaim)
-- 1 = reclaimed
-- 2 = heartbeat re-appeared (US2)
-- 3 = within grace window (FR-005)

local claimed = redis.call('HGET', KEYS[1], ARGV[1])
if not claimed then
  return 0
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return 2
end

if tonumber(ARGV[2]) < tonumber(ARGV[3]) then
  return 3
end

redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
end

redis.call('SREM', KEYS[3], ARGV[1])
redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), ARGV[5])

return 1
```

## Client-side pre-computation

Before invoking the script per orphan candidate, the adapter does (already in memory from the outer-loop `HGETALL`):

```ts
const parsed: SerializedQueueItem = JSON.parse(claimedPayload);
const ageMs = now - Date.parse(parsed.enqueuedAt);
const reclaimItem: SerializedQueueItem = {
  ...parsed,
  attemptCount: parsed.attemptCount + 1,   // FR-002 / Q3=C
  queueReason: 'resume',                    // AD-9
  priority: getPriorityScore('resume'),     // 0
};
const reclaimItemJSON = JSON.stringify(reclaimItem);
```

Then:

```ts
const result: number = await redis.reclaimOrphan(
  claimedKey, heartbeatKey, IN_FLIGHT_KEY, PENDING_KEY,
  itemKey,
  String(ageMs),
  String(graceWindowMs),
  String(getPriorityScore('resume')),
  reclaimItemJSON,
);
```

## Atomicity notes

- All four writes (`HDEL`, optional `DEL`, `SREM`, `ZADD`) execute inside one Lua `EVALSHA` — no interleaving possible.
- The `HGET` + `EXISTS` + grace check + write sequence is one script → server-side atomic. A concurrent worker's `SET heartbeat` cannot land between the `EXISTS` check and the writes.
- Redis's automatic empty-hash cleanup makes the explicit `DEL` on `HLEN == 0` redundant but harmless. Kept for explicitness and forward-compat across Redis versions.

## Failure modes handled

| Scenario | Return code | Behaviour |
|---|---|---|
| Two dispatchers race the same orphan | `1` for first, `0` for second | Second finds empty claim field (`HGET` → nil), no-ops. No double-enqueue. |
| Heartbeat re-appears in the microsecond window between outer `EXISTS` and script `EXISTS` | `2` | Script aborts; nothing mutated. Outer log line records "raced/skipped". |
| Claim was made in the last 30s | `3` | Script aborts; outer log line records "grace/skipped". |
| Claim payload has malformed JSON | `1` (write still proceeds with the malformed payload preserved as-is in the reclaim item) | Not a Lua-side concern; the client-side pre-computation would have thrown before reaching the script. In practice, malformed JSON in a claim hash is a pre-existing bug not introduced by this fix. |

## Non-failure modes (silently correct)

| Scenario | Outcome |
|---|---|
| Claim hash key doesn't exist at all (SCAN returned a stale key) | `HGET` → nil → return 0 |
| itemKey no longer in in-flight SET (was cleaned by concurrent `complete()`) | `SREM` returns 0 (no-op); script still succeeds. The `ZADD` re-enqueues the item — but if it was `complete()`d, the completing worker's next monitor cycle finds no unresolved threads / no failing labels / etc. and drops via `enqueueIfAbsent` returning false. Same as steady-state healthy dedup. |

## Registered command name

`RedisQueueAdapter.ensureReclaimOrphanCommand()` registers this script as `reclaimOrphan` on the ioredis client, following the existing pattern:

```ts
this.redis.defineCommand('reclaimOrphan', {
  numberOfKeys: 4,
  lua: RECLAIM_ORPHAN_SCRIPT,
});
```

Called via `(this.redis as any).reclaimOrphan(...)` — the `any` cast mirrors existing usage at `redis-queue-adapter.ts:125` and `:199`.
