# Data Model — #1058 Periodic in-flight/claim reconciliation

## Interfaces & Types

### `QueueManager` — widened (existing interface, one new method)

Location: `packages/orchestrator/src/types/monitor.ts:320-406`

Add one method (co-located with `reapOrphanClaims` at `:398`):

```ts
export interface QueueManager extends QueueAdapter {
  // ... existing members ...

  /**
   * FR-001: reconciliation sweep that closes the residue gap where an
   * `itemKey` exists in `orchestrator:queue:in-flight-items` without a
   * matching pending or claim entry. Runs on the dispatcher's reaper
   * cadence, immediately after `reapOrphanClaims` (AD-5).
   *
   * Two-sweep confirmation gate (Q1=D): a residue candidate must be
   * observed in two consecutive sweeps before it is `SREM`'d. Cross-sweep
   * state lives in an in-memory `Map<itemKey, firstSeenSweepId>` on the
   * adapter — process-local, bounded by residue population.
   *
   * Atomic per-item Lua re-check via `RECONCILE_IN_FLIGHT_SCRIPT`:
   * `SISMEMBER` + `SREM` on `IN_FLIGHT_KEY` only, `numberOfKeys: 1`. The
   * script's role is limited to catching the narrow race where an item
   * genuinely re-entered flight between the client-side residue
   * computation and the Lua invocation for that specific candidate.
   *
   * Never throws. On transport error mid-sweep: `warn` + returns partial
   * report so subsequent cycles retry.
   *
   * @param now epoch-ms; parameterized for testability (default `Date.now()`)
   */
  reconcileInFlight(now?: number): Promise<ReconcileReport>;
}
```

### `ReconcileReport` — new type

Location: `packages/orchestrator/src/types/monitor.ts` (after `ReapReport` at `:435-444`)

```ts
/**
 * Aggregate result of one `reconcileInFlight` sweep. Consumed by the
 * dispatcher's per-cycle log line at the same site as the
 * `reap-orphan-claims` event.
 */
export interface ReconcileReport {
  /** Number of `IN_FLIGHT_KEY` members examined via `SSCAN`. */
  scanned: number;
  /** Successful `SREM`s issued this cycle (post two-sweep confirmation). */
  reconciled: number;
  /**
   * Items that were confirmed residue candidates but had re-entered flight
   * between the client-side residue computation and the Lua invocation
   * (Lua `SISMEMBER` returned 0). Tracker entry remains for one more cycle
   * to re-confirm; if still residue, next cycle's `SREM` fires.
   */
  skippedRaceReappeared: number;
  /**
   * Items entering the two-sweep tracker this cycle (first-sweep sighting).
   * These will be re-evaluated next cycle; if still residue at that time,
   * they graduate to `reconciled` (or `skippedRaceReappeared` on Lua race).
   */
  trackedFirstSeen: number;
}
```

### `RedisQueueAdapter` — new private fields

Location: `packages/orchestrator/src/services/redis-queue-adapter.ts:312-353`

```ts
export class RedisQueueAdapter implements QueueManager {
  // ... existing fields ...

  /**
   * FR-001 / Q1=D — two-sweep tracker for residue candidates. Keyed by
   * itemKey; value is the sweep-id at which the candidate was first
   * observed as residue. On the next sweep, if the itemKey is still
   * residue AND `firstSeenSweepId < currentSweepId`, the atomic
   * `RECONCILE_IN_FLIGHT_SCRIPT` fires.
   *
   * Bounded by residue population: entries insert on first-sweep,
   * delete on successful `SREM` OR when the itemKey re-appears in
   * pending/claimed (transient race artifact self-clears).
   */
  private readonly reconcileTracker = new Map<string, number>();

  /**
   * FR-001 — monotonically increasing sweep counter. Incremented once
   * per `reconcileInFlight()` invocation to distinguish first-sweep
   * from subsequent-sweep sightings.
   */
  private reconcileSweepCounter = 0;

  /**
   * FR-001 — Lua command registration guard, mirrors the existing
   * `ensureXCommand()` pattern (e.g. `ensureReclaimOrphanCommand()`).
   */
  private reconcileInFlightCommandDefined = false;
}
```

### `RECONCILE_IN_FLIGHT_SCRIPT` — new module-level constant

Location: `packages/orchestrator/src/services/redis-queue-adapter.ts` (before class body)

```ts
/**
 * FR-001 / FR-002 — atomic `SISMEMBER`+`SREM` for a two-sweep-confirmed
 * residue candidate. The load-bearing race guard is the two-sweep tracker
 * in the adapter (`reconcileTracker`); this script's role is limited to
 * catching the narrow window where an item genuinely re-entered flight
 * between the client-side residue computation and the Lua invocation for
 * this specific candidate.
 *
 * KEYS[1] = orchestrator:queue:in-flight-items
 * ARGV[1] = itemKey
 *
 * Returns:
 *   1 = reconciled (SREM fired)
 *   0 = skipped-race-reappeared (item was gone before we could SREM, or a
 *       concurrent `enqueueIfAbsent`/`enqueue` re-added it after our
 *       client-side detection but before this Lua fired — either way,
 *       we do NOT SREM)
 */
const RECONCILE_IN_FLIGHT_SCRIPT = `
local exists = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if exists == 0 then
  return 0
end
redis.call('SREM', KEYS[1], ARGV[1])
return 1
`;

/**
 * Exported for the script-wiring static-assertion tests only. Not part of
 * the runtime API.
 * @internal
 */
export const _RECONCILE_IN_FLIGHT_SCRIPT_FOR_TESTS = RECONCILE_IN_FLIGHT_SCRIPT;
```

### `RECONCILE_LOG_CAP` — new module-level constant

Location: `packages/orchestrator/src/services/redis-queue-adapter.ts` (before class body)

```ts
/**
 * FR-004 / Q4=B — max individual `orphan-in-flight-reconciled` warn lines
 * per reconcileInFlight cycle. Beyond this cap, suppress and emit one
 * aggregate `orphan-in-flight-reconciled-batch` warn with sample keys.
 */
const RECONCILE_LOG_CAP = 100;
```

## Redis Data Shape (existing, referenced by the new sweep)

### `orchestrator:queue:in-flight-items` — SET

Existing. Membership: itemKey (`<owner>/<repo>#<issue>`). Modified by:
- `enqueueIfAbsent` / `enqueue` — `SADD` (via `ENQUEUE_IF_ABSENT_SCRIPT`) on successful enqueue.
- `complete` — `SREM` on successful completion.
- `RELEASE_SCRIPT` — `SREM` on dead-letter branch only (retry branch preserves membership).
- `RECLAIM_ORPHAN_SCRIPT` — does NOT `SREM` (item stays in flight after reclaim, moved from claimed to pending).
- `REQUEUE_FOR_RESUME_SCRIPT` — does NOT `SREM` (same as reclaim).
- **NEW**: `RECONCILE_IN_FLIGHT_SCRIPT` — `SREM` on residue confirmation.

Read by:
- `hasInFlight`, `hasInFlightAge`, `enqueueIfAbsent`/`enqueue` `SISMEMBER` guard.
- **NEW**: `reconcileInFlight` — `SSCAN` for candidate enumeration.

### `orchestrator:queue:pending` — SORTED SET

Existing. Member: serialized `SerializedQueueItem` JSON. Score: priority. Read by `reconcileInFlight` via `ZRANGE PENDING_KEY 0 -1` + `JSON.parse` per member to extract `itemKey` for the client-side set-difference.

### `orchestrator:queue:claimed:<workerId>` — HASH

Existing. One key per active worker; fields are `itemKey → serialized JSON`. Read by `reconcileInFlight` via `SCAN CLAIMED_KEY_PREFIX*` + `HKEYS` per claim hash to enumerate claimed itemKeys.

## Validation Rules

### `RECONCILE_IN_FLIGHT_SCRIPT` argument shape

Enforced at the client boundary (`RedisQueueAdapter.reconcileInFlight` per-candidate invocation):

- `KEYS[1]` — `orchestrator:queue:in-flight-items`
- `ARGV[1]` — itemKey (`<owner>/<repo>#<issue>`; opaque UTF-8 string, matches existing SET member shape)

Return codes:
- `0` — skipped-race-reappeared (item absent from SET at Lua time — either concurrent `SREM` or item was never actually in SET at client-side snapshot time — either way, no-op)
- `1` — reconciled

### `ReconcileReport.scanned`

Positive integer. Equal to the count of unique `IN_FLIGHT_KEY` members observed across all `SSCAN` batches this cycle. Under `SSCAN` cursor semantics, members added mid-sweep may or may not be visible on this cycle; those missed will be included on the next cycle (harmless — the tracker gate absorbs).

### `ReconcileReport.reconciled`

Positive integer. Bounded above by `scanned` and by the tracker Map's confirmed-candidate population at the start of the cycle.

### `ReconcileReport.skippedRaceReappeared`

Positive integer. Incremented when `RECONCILE_IN_FLIGHT_SCRIPT` returns `0` on a confirmed candidate (the Lua's `SISMEMBER` returned 0). The tracker entry for this itemKey is retained for the next sweep — if the item is still residue then, next sweep's Lua re-fires.

### `ReconcileReport.trackedFirstSeen`

Positive integer. Count of itemKeys inserted into `reconcileTracker` this cycle (first-sweep observations). Not `SREM`'d this cycle; will be re-evaluated next cycle.

## Relationships

```
WorkerDispatcher.start()
        │
        ├──► [boot sweep — fire-and-forget]
        │        └──► RedisQueueAdapter.reconcileInFlight()
        │                 ├──► SSCAN IN_FLIGHT_KEY (candidate enumeration)
        │                 ├──► ZRANGE PENDING_KEY 0 -1 (pending snapshot, JSON.parse per member)
        │                 ├──► SCAN CLAIMED_KEY_PREFIX* + HKEYS per hash (claimed snapshot)
        │                 └──► client-side set-difference → residue candidates
        │                          │
        │                          └──► for each candidate:
        │                                    if not in reconcileTracker → INSERT + debug log
        │                                    if in reconcileTracker with firstSeenSweepId < currentSweepId →
        │                                        RECONCILE_IN_FLIGHT_SCRIPT (SISMEMBER + SREM)
        │                                        on return 1: reconciled++; delete tracker;
        │                                                     enqueuedAtCache.delete; dropLogState.delete
        │                                        on return 0: skippedRaceReappeared++; keep tracker
        │                                    else (candidate absent from current residue) → delete tracker
        │
        └──► reaperLoop(signal) [spawned]
                 │
                 └──► every heartbeatCheckIntervalMs:
                          ├──► reapStaleWorkers() [in-memory]
                          ├──► queue.reapOrphanClaims() [existing]
                          └──► queue.reconcileInFlight() [new]  ── AD-5 sequential


RedisQueueAdapter (instance)
        │
        ├──► reconcileTracker: Map<itemKey, firstSeenSweepId>   [in-memory, per-instance]
        ├──► reconcileSweepCounter: number                       [monotonic per instance]
        ├──► enqueuedAtCache: Map<itemKey, enqueuedAtMs>         [existing; cleared on SREM per AD-6]
        └──► dropLogState: Map<itemKey, DropTransitionState>     [existing; cleared on SREM per AD-6]
```

## State Machine — one wedged itemKey through the reconcile path

```
[wedge produced]                     IN_FLIGHT_KEY has "owner/repo#N"; pending has no member for it;
                                     no claim hash has it as a field
        │
        │ [source of wedge: memory eviction of claim hash, operator DEL, future refactor bug]
        │
        ▼
[sweep N (first observation)]        reconcileInFlight() computes residue candidates.
                                     "owner/repo#N" is in residue set.
                                     reconcileTracker.get("owner/repo#N") → undefined.
                                     INSERT reconcileTracker.set("owner/repo#N", N).
                                     Emit `debug`: { event: 'orphan-in-flight-tracked', itemKey, firstSeenSweepId: N }.
                                     Increment trackedFirstSeen. Do NOT SREM.
        │
        │ [sleep heartbeatCheckIntervalMs]
        │
        ▼
[sweep N+1 (confirmation)]           reconcileInFlight() recomputes residue candidates.
                                     "owner/repo#N" still in residue.
                                     reconcileTracker.get("owner/repo#N") → N < N+1.
                                     Invoke RECONCILE_IN_FLIGHT_SCRIPT("owner/repo#N").
                                        └──► Lua: SISMEMBER → 1 → SREM → return 1.
                                     Increment reconciled. Delete tracker entry.
                                     enqueuedAtCache.delete("owner/repo#N").
                                     dropLogState.delete("owner/repo#N").
                                     Emit `warn`: { event: 'orphan-in-flight-reconciled', itemKey, ageMs, reason: ... }.
        │
        ▼
[repaired]                           IN_FLIGHT_KEY no longer contains "owner/repo#N".
                                     Next enqueueIfAbsent({ itemKey: "owner/repo#N", ... }) succeeds:
                                     `SISMEMBER` returns 0, `SADD` + `ZADD` fire, item enters pending,
                                     dispatcher can claim on next poll.
```

Total wedge duration upper bound: `~2 × heartbeatCheckIntervalMs` from the first sweep that sees the wedge (60s at the 30s default). With the boot sweep (AD-4), a wedge already present at process start is armed by boot-sweep completion (~immediate) and repaired at the first regular sweep (~30s at defaults). Matches SC-005's `≤ 3 × heartbeatCheckIntervalMs` target.

## State Machine — transient race artifact (false-positive residue)

```
[legitimate dispatch transition]     Worker A calls claim(). CLAIM_SCRIPT moves an item from pending to claimed.
                                     Between the client-side ZRANGE snapshot and the SCAN claimed:* snapshot,
                                     the item's location moves — for a microsecond window, the client sees:
                                       - pending snapshot: item NOT present (already moved by CLAIM_SCRIPT)
                                       - claimed snapshot: item NOT present (SCAN caught the state before HSET)
                                     Item is in residue candidates this cycle.
        │
        ▼
[sweep N (first observation)]        Same as wedge path above: INSERT reconcileTracker.set(itemKey, N).
                                     Emit `debug` event. Do NOT SREM.
        │
        │ [sleep heartbeatCheckIntervalMs — race window resolved]
        │
        ▼
[sweep N+1 (self-clear)]             reconcileInFlight() recomputes residue candidates.
                                     Item is NOW in claimed (or completed and gone entirely, or re-pended).
                                     Item is NOT in current residue set.
                                     Iterate reconcileTracker entries — for any tracker key not in current
                                     residue set: delete without SREM.
                                     No `warn`, no `SREM`, no correctness impact.
```

This is the failure mode Q1=D (two-sweep gate) is designed to close. The atomic Lua re-check alone cannot distinguish this from a genuine wedge — both look the same at a single snapshot instant. The two-sweep gate uses time as the discriminator: real wedges persist; race artifacts don't.
