# Quickstart: RedisQueueAdapter.enqueue() invariant fix

## Running the tests

From the repo root:

```bash
# Fast — in-memory suite + unit tests, no Redis needed.
pnpm --filter @generacy-ai/orchestrator test src/services/__tests__/in-memory-queue-adapter.enqueue-invariant.test.ts

# Full — includes real-Redis suite and cross-adapter parity.
# Assumes a live Redis at $REDIS_URL (default `redis://localhost:6379`).
pnpm --filter @generacy-ai/orchestrator test src/services/__tests__/redis-queue-adapter.enqueue-invariant.test.ts \
  src/services/__tests__/queue-adapter-parity.test.ts
```

Live-Redis tests reuse the same connection-string convention as the existing `redis-queue-adapter.orphan-reclaim.test.ts` and `redis-queue-adapter.reclaim-lua.test.ts`. If those pass locally, this suite will too.

## Reproducing the observed incident (before the fix)

The observed 2026-07-28 wedge shape is `an item in a claimed hash with no in-flight-SET membership`. Reproduce against a live Redis with the pre-fix code:

```bash
# Terminal 1 — pre-fix orchestrator (`git checkout` a pre-#1060 commit).
pnpm dev

# Terminal 2 — Redis inspection.
redis-cli
> ZRANGE orchestrator:queue:pending 0 -1 WITHSCORES
> SMEMBERS orchestrator:queue:in-flight-items
> KEYS orchestrator:queue:claimed:*
```

Trigger a `process:speckit-feature` label on any issue. Watch:

- `ZRANGE pending` grows by 1.
- `SMEMBERS in-flight-items` stays empty — **the bug**.
- When the dispatcher claims, `pending` shrinks and `claimed:<workerId>` grows.
- `SMEMBERS in-flight-items` still empty.
- Fire any second monitor (e.g., PR comment on the same issue) that hits `enqueueIfAbsent` — `pending` gains a second distinct member; a second worker claims; two workers on one issue.

## Reproducing the fix (after the fix)

Same setup, post-fix code:

- `ZRANGE pending` grows by 1.
- `SMEMBERS in-flight-items` contains the itemKey — **the fix**.
- Any subsequent `enqueue()` or `enqueueIfAbsent()` for the same itemKey is dropped. `ZCARD pending` stays at 1. Only one worker claims.

## Inspecting drop-log severity

The FR-005 drop line funnels through `emitDropLog`. Query filtering:

```bash
# All enqueue-side drop lines, both verbs.
pnpm logs --filter orchestrator | jq 'select(.reason == "in-flight" and (.source == "enqueue" or .source == "enqueueIfAbsent"))'

# Only transition-edge warns (wedge open / wedge close).
pnpm logs --filter orchestrator | jq 'select(.reason == "in-flight" and .severity != null)'
```

Field-shape parity: `enqueue` and `enqueueIfAbsent` drop lines share `{ itemKey, source, reason, ageMs, severity? }` — the only difference is `.source`.

## Manual invariant check

After any orchestrator operation, this Redis-side check MUST hold:

```bash
redis-cli --raw <<'EOF'
LUA "
local pending_keys = {}
local pending = redis.call('ZRANGE', 'orchestrator:queue:pending', 0, -1)
for _, m in ipairs(pending) do
  local parsed = cjson.decode(m)
  table.insert(pending_keys, parsed.itemKey)
end

local claimed_keys = {}
local cursor = '0'
repeat
  local scan = redis.call('SCAN', cursor, 'MATCH', 'orchestrator:queue:claimed:*', 'COUNT', 100)
  cursor = scan[1]
  for _, key in ipairs(scan[2]) do
    for _, field in ipairs(redis.call('HKEYS', key)) do
      table.insert(claimed_keys, field)
    end
  end
until cursor == '0'

local in_flight = redis.call('SMEMBERS', 'orchestrator:queue:in-flight-items')

-- Set equality: sort each and compare.
local expected = {}
for _, k in ipairs(pending_keys) do expected[k] = true end
for _, k in ipairs(claimed_keys) do expected[k] = true end

local diff_missing = {}
local diff_extra = {}
for _, k in ipairs(in_flight) do
  if not expected[k] then table.insert(diff_extra, k) end
end
for k, _ in pairs(expected) do
  local found = false
  for _, m in ipairs(in_flight) do if m == k then found = true; break end end
  if not found then table.insert(diff_missing, k) end
end

return { missing = diff_missing, extra = diff_extra }
"
EOF
```

Any non-empty `missing` or `extra` array indicates an invariant break. Before the fix, `missing` populates on every routine `enqueue()`. After the fix, both are always empty.

## Available operations (unchanged)

The public interface adds nothing new — only the return type of `enqueue` migrates:

- `queue.enqueue(item): Promise<boolean>` — new return type. `true` on enqueue, `false` on drop.
- `queue.enqueueIfAbsent(item): Promise<boolean>` — unchanged.
- `queue.claim(workerId): Promise<QueueItem | null>` — unchanged.
- `queue.release(workerId, item): Promise<void>` — unchanged.
- `queue.complete(workerId, item): Promise<void>` — unchanged.
- `queue.hasInFlight(itemKey): Promise<boolean>` — unchanged.
- `queue.hasInFlightAge(itemKey): Promise<number | null>` — unchanged.
- `queue.reapOrphanClaims(now?): Promise<ReapReport>` — unchanged.
- `queue.getQueueDepth(): Promise<number>` — unchanged.
- `queue.getQueueItems(offset, limit): Promise<QueueItemWithScore[]>` — unchanged.
- `queue.getActiveWorkerCount(): Promise<number>` — unchanged.

## Troubleshooting

**Symptom**: `enqueue()` returns `false` unexpectedly on what should be a fresh item.
**Diagnosis**: the itemKey is already in the in-flight SET. Check `SMEMBERS orchestrator:queue:in-flight-items` and `KEYS orchestrator:queue:claimed:*`. Either an earlier `enqueue`/`enqueueIfAbsent` already ran, or a `complete()`/`release()` dead-letter dropped the ZSET/hash entry but failed to `SREM` (transport error mid-`.multi()` — check `pnpm logs | grep 'Redis error in complete\|release'`).

**Symptom**: two workers claim the same issue after the fix.
**Diagnosis**: the fix should make this impossible unless (a) the SET was cleared out-of-band (manual `DEL`), or (b) the new Lua script is not registered (`ensureEnqueueCommand()` never ran). Verify with `redis-cli SCRIPT EXISTS <sha1 of ENQUEUE_SCRIPT>`.

**Symptom**: `handleLeaseExpired`'s re-enqueue silently drops but the item never re-runs.
**Diagnosis**: expected under FR-003 — the `release()` call already re-pended before the (redundant) `enqueue()` call. Check `ZRANGE pending` for the itemKey; it should be present.

**Symptom**: log line volume increases after the fix.
**Diagnosis**: unexpected. `emitDropLog` uses transition-edge throttling — one `warn` on wedge open, one on wedge close, `info` in between. If seeing per-cycle spam, verify `classifyDropSeverity`'s `dropLogState` Map is scoped per-adapter-instance (not per-call).
