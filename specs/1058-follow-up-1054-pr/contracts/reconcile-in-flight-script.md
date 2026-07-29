# Contract — `RECONCILE_IN_FLIGHT_SCRIPT`

Load-bearing invariant for FR-002 (atomic per-item race window closure). Composes with FR-001's two-sweep tracker (in-memory, adapter-owned) as the class-of-races closure.

## Wire shape

```lua
-- KEYS[1] = orchestrator:queue:in-flight-items
-- ARGV[1] = itemKey (`<owner>/<repo>#<issue>`; opaque UTF-8 string)

-- Return codes:
--   1 = reconciled (SREM fired)
--   0 = skipped-race-reappeared (SISMEMBER returned 0 — item was already
--       gone, or a concurrent SADD from enqueueIfAbsent/enqueue is racing
--       with this Lua invocation. Either way, do NOT SREM.)

local exists = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if exists == 0 then
  return 0
end
redis.call('SREM', KEYS[1], ARGV[1])
return 1
```

## Client-side pre-computation

Per-cycle (once):

```ts
this.reconcileSweepCounter += 1;
const sweepId = this.reconcileSweepCounter;

// (1) Snapshot in-flight via SSCAN (bounded COUNT).
const inFlightSet = new Set<string>();
let cursor = '0';
do {
  const [next, batch] = await this.redis.sscan(IN_FLIGHT_KEY, cursor, 'COUNT', 100);
  cursor = next;
  for (const key of batch) inFlightSet.add(key);
} while (cursor !== '0');

// (2) Snapshot pending itemKeys via ZRANGE + JSON.parse.
const pendingSet = new Set<string>();
const pendingMembers = await this.redis.zrange(PENDING_KEY, 0, -1);
for (const member of pendingMembers) {
  try {
    const parsed: SerializedQueueItem = JSON.parse(member);
    if (parsed.itemKey) pendingSet.add(parsed.itemKey);
  } catch { /* malformed member — separate correctness concern, skip */ }
}

// (3) Snapshot claimed itemKeys via SCAN claimed:* + HKEYS.
const claimedSet = new Set<string>();
let claimedCursor = '0';
do {
  const [next, keys] = await this.redis.scan(
    claimedCursor, 'MATCH', `${CLAIMED_KEY_PREFIX}*`, 'COUNT', 100
  );
  claimedCursor = next;
  for (const claimedKey of keys) {
    const fields = await this.redis.hkeys(claimedKey);
    for (const itemKey of fields) claimedSet.add(itemKey);
  }
} while (claimedCursor !== '0');

// (4) Client-side set-difference → residue candidates.
const residue = new Set<string>();
for (const itemKey of inFlightSet) {
  if (!pendingSet.has(itemKey) && !claimedSet.has(itemKey)) {
    residue.add(itemKey);
  }
}

// (5) Two-sweep gate: for each candidate in `residue`, consult tracker.
//     For each tracker entry not in current `residue`: delete (self-clear).
```

Per-confirmed-candidate:

```ts
const result: number = await (this.redis as any).reconcileInFlight(
  IN_FLIGHT_KEY,
  itemKey,
);

if (result === 1) {
  // reconciled: cleanup adjacent caches (AD-6).
  const enqueuedAtMs = this.enqueuedAtCache.get(itemKey);
  const ageMs = enqueuedAtMs !== undefined ? now - enqueuedAtMs : null;
  this.reconcileTracker.delete(itemKey);
  this.enqueuedAtCache.delete(itemKey);
  this.dropLogState.delete(itemKey);
  report.reconciled += 1;
  // emit warn with FR-004 log-cap accounting …
} else {
  // skipped-race-reappeared: retain tracker entry for next sweep.
  report.skippedRaceReappeared += 1;
  // tracker entry NOT deleted — next sweep re-evaluates
}
```

## Atomicity notes

- The `SISMEMBER` + `SREM` sequence executes inside one Lua `EVALSHA` — no interleaving possible under Redis single-threaded execution.
- A concurrent `SADD` from `enqueueIfAbsent`/`enqueue` cannot land between the `SISMEMBER` and the `SREM` inside the script body. It can land either strictly before (SISMEMBER sees 1, SREM fires — correct behavior since the item WAS in flight for the moment the tracker confirmed it as residue) or strictly after (SREM already fired, SADD re-adds — final state: item in SET, item in pending, next claim picks it up).
- The narrow race the script guards against: between the client-side snapshot (step 1-4 above) and the per-candidate Lua invocation, another actor (`enqueueIfAbsent` racing on the exact wedged itemKey) may `SADD` and `ZADD`. The client sees residue candidate; Lua time later, the item is legitimately live. The `SISMEMBER` re-check catches this — but only for items that had been `SREM`'d from the SET by another path in between (impossible under our current code paths, since only `RECONCILE_IN_FLIGHT_SCRIPT`, `complete`, and `RELEASE_SCRIPT`'s dead-letter branch `SREM` from `IN_FLIGHT_KEY`, and none of those fire concurrently on a wedged itemKey). In practice, `SISMEMBER` returning 0 in this Lua indicates a concurrent second reconcile invocation (impossible — the reaperLoop is single-threaded per dispatcher) OR a `complete`/`release` on the item (impossible — a wedged item has no claim, so no worker is calling `complete` for it). Either way, `SISMEMBER == 0` → no-op, safe.
- No CROSSSLOT risk: `numberOfKeys: 1`, single key argument. Safe under Redis Cluster with any hash-slot configuration.

## Failure modes handled

| Scenario | Return code | Behavior |
|---|---|---|
| Item still in SET at Lua time (normal wedge) | `1` | `SREM` fires; caller cleans up caches, emits `warn` |
| Item absent from SET at Lua time (SISMEMBER == 0) | `0` | No-op. Caller retains tracker entry; next sweep re-evaluates |
| Redis transport error mid-Lua | (throws) | Caller's per-candidate `.catch()` logs `warn`, increments no counter, retains tracker for next cycle |
| Malformed itemKey (empty string, oversized, etc.) | `0` or `1` | The SET was populated with this itemKey through the same primitives (`SADD` accepts any binary-safe string); Lua doesn't validate. If genuinely in SET → reconciled; if not → no-op |

## Non-failure modes (silently correct)

| Scenario | Outcome |
|---|---|
| itemKey never was in SET (client-side snapshot bug) | `SISMEMBER` returns 0 → no-op |
| Concurrent second dispatcher runs `reconcileInFlight` on the same itemKey | First dispatcher's `SREM` succeeds (returns 1); second dispatcher's `SISMEMBER` returns 0 (returns 0); no double-count, no error |
| Concurrent `enqueueIfAbsent` fires `SADD` AFTER `SISMEMBER` but BEFORE `SREM` | Impossible under Lua atomicity — Redis executes the script body without interleaving. Concurrent `SADD` lands either before `SISMEMBER` (`SISMEMBER` returns 1, `SREM` fires, item is removed; concurrent enqueue's `ZADD` is undone by our `SREM` on IN_FLIGHT but its `ZADD` on pending stands — this is the R6 case in plan.md, resolvable by the next sweep or by natural claim) or after `SREM` (item re-added; residue is genuinely new, tracker re-observes next sweep) |

## Registered command name

`RedisQueueAdapter.ensureReconcileInFlightCommand()` registers this script following the existing pattern (mirrors `ensureReclaimOrphanCommand()` at `redis-queue-adapter.ts:373-380`, `ensureRequeueForResumeCommand()` at `:382-391`, `ensureReleaseCommand()` at `:393-401`):

```ts
private reconcileInFlightCommandDefined = false;

private ensureReconcileInFlightCommand(): void {
  if (this.reconcileInFlightCommandDefined) return;
  // Command name uses the `Item` suffix so it does not shadow this
  // class's own `reconcileInFlight` method on the ioredis client object
  // (same convention as `ensureRequeueForResumeCommand`, `ensureReleaseCommand`).
  this.redis.defineCommand('reconcileInFlightItem', {
    numberOfKeys: 1,
    lua: RECONCILE_IN_FLIGHT_SCRIPT,
  });
  this.reconcileInFlightCommandDefined = true;
}
```

Called via `(this.redis as any).reconcileInFlightItem(...)` — the `any` cast mirrors existing usage at `redis-queue-adapter.ts:687` (`reclaimOrphan`), etc.

## Script-wiring static assertion

Extend `packages/orchestrator/src/services/__tests__/redis-queue-adapter.script-wiring.test.ts` to include:

```ts
describe('RECONCILE_IN_FLIGHT_SCRIPT wire shape', () => {
  it('runs SISMEMBER then SREM in order (single-source-of-truth for the two-command shape)', () => {
    const body = _RECONCILE_IN_FLIGHT_SCRIPT_FOR_TESTS;
    const sismember = body.indexOf(`redis.call('SISMEMBER'`);
    const srem = body.indexOf(`redis.call('SREM'`);
    expect(sismember).toBeGreaterThanOrEqual(0);
    expect(srem).toBeGreaterThan(sismember);
  });

  it('registers with numberOfKeys: 1 (CROSSSLOT-safe by construction)', async () => {
    const redis = new Redis(...);
    const adapter = new RedisQueueAdapter(redis, logger);
    // trigger command definition via a no-op call
    await adapter.reconcileInFlight();
    const registered = (redis as any).reconcileInFlightItem;
    expect(registered).toBeDefined();
    // ioredis stores the numberOfKeys on the command definition — assert via
    // whatever introspection matches the existing script-wiring test style.
  });
});
```
