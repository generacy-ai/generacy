# Data Model — #1054 Orphaned queue claims

## Interfaces & Types

### `QueueManager` — widened (existing interface, new method)

Location: `packages/orchestrator/src/types/monitor.ts:256-293`

Add one method:

```ts
export interface QueueManager extends QueueAdapter {
  // ... existing members (claim, release, complete, getQueueDepth, getQueueItems,
  // getActiveWorkerCount, enqueueIfAbsent, hasInFlight) ...

  /**
   * FR-001 / FR-002 / FR-004: reclaim orphaned claims whose owning worker's
   * heartbeat is absent. Runs on the dispatcher's reaper cadence.
   *
   * Race safety (US2): the outer-loop `EXISTS heartbeat` check is an
   * optimization; the load-bearing guard is the server-side re-check inside
   * `RECLAIM_ORPHAN_SCRIPT`. A heartbeat that re-appears between the two
   * checks aborts the reclaim without mutating state.
   *
   * Grace window (FR-005): claims younger than `2 × heartbeatCheckIntervalMs`
   * are skipped to defend against a hypothetical future refactor that splits
   * `CLAIM_SCRIPT`'s atomicity.
   *
   * @param now — epoch-ms; parameterized for testability (default `Date.now()`)
   */
  reapOrphanClaims(now?: number): Promise<ReapReport>;

  /**
   * Observability accessor — returns the age in ms of the given itemKey's
   * in-flight entry, or `null` if not in flight OR on transport error.
   * Called by monitor-side drop sites to compute `ageMs` for the shared
   * severity dispatcher (FR-006/FR-007).
   */
  hasInFlightAge(itemKey: string): Promise<number | null>;
}
```

### `ReapReport` — new type

```ts
/**
 * Aggregate result of one `reapOrphanClaims` sweep. Consumed by the
 * dispatcher's per-cycle log line (info when nonzero).
 */
export interface ReapReport {
  /** Number of claim keys iterated. */
  scanned: number;
  /** Successfully reclaimed items (payload per entry). */
  reclaimed: ReclaimedItem[];
  /** Skipped because heartbeat re-appeared server-side (US2 defence). */
  skippedRaceReappeared: number;
  /** Skipped because claim was within the grace window (FR-005). */
  skippedGraceWindow: number;
}

export interface ReclaimedItem {
  workerId: string;
  itemKey: string;
  ageMs: number;
  attemptCountBefore: number;
  attemptCountAfter: number;
}
```

### `DispatchConfig` — widened

Location: `packages/orchestrator/src/config/schema.ts:164-178`

Add one field:

```ts
export const DispatchConfigSchema = z.object({
  // ... existing fields ...

  /**
   * Maximum plausible run duration for a single claim. Drop-log lines from
   * `enqueueIfAbsent` (adapter) and the four monitor sites escalate from
   * `info` to `warn` on the transition edge when a wedged in-flight entry's
   * age crosses this threshold.
   *
   * Default 30 min per clarifications Q1=A: comfortably above the 20-min
   * CLI timeout that produced the observed 84-min wedge in #1054, so
   * legitimate post-timeout work (partial push, label updates) doesn't
   * emit spurious warns; still fires on the very next monitor cycle for
   * the pathological case.
   */
  maxRunDurationMs: z.number().int().min(60_000).default(1_800_000),
});
```

### `DropTransitionState` + `DropSeverityDecision` — new types

Location: `packages/orchestrator/src/services/drop-log-helper.ts`

```ts
/**
 * Per-itemKey severity-state, remembered across drop calls so the helper
 * can emit `warn` exactly once when the entry crosses the threshold and
 * once when it clears — never per-cycle. Callers own the Map.
 */
export interface DropTransitionState {
  lastSeverity: 'info' | 'warn';
}

export interface DropSeverityDecision {
  severity: 'info' | 'warn';
  isTransitionEdge: boolean;
  stateAfter: DropTransitionState;
}

export function classifyDropSeverity(
  itemKey: string,
  ageMs: number | null,
  thresholdMs: number,
  state: Map<string, DropTransitionState>,
): DropSeverityDecision;

export function emitDropLog(
  logger: Logger,
  decision: DropSeverityDecision,
  payload: Record<string, unknown>,
  message: string,
): void;
```

## Redis Data Shape (existing, referenced by the new sweep)

### `orchestrator:queue:claimed:<workerId>` — HASH

Existing. One key per active worker; fields are `itemKey → serialized JSON`.

```
HGETALL orchestrator:queue:claimed:177e2263-5ea7-4e84-83a5-eec6b46a7c12
  1) "generacy-ai/generacy#1051"
  2) '{"itemKey":"generacy-ai/generacy#1051","workflowName":"speckit-feature",
      "command":"address-pr-feedback","priority":0,"queueReason":"resume",
      "enqueuedAt":"2026-07-27T19:17:18.772Z","attemptCount":0,
      "metadata":{"prNumber":1052,"reviewThreadIds":[3660221572,3660221578]}}'
```

Read by:
- `reapOrphanClaims` — enumerates fields, parses payload, invokes reclaim script per orphan.
- `hasInFlightAge` — enumerates fields, finds itemKey match, returns `now - parseDate(enqueuedAt)`.

### `orchestrator:worker:<workerId>:heartbeat` — STRING with TTL

Existing. Presence-or-absence is the liveness signal. Value is `"1"`; TTL managed by `startHeartbeat` (`worker-dispatcher.ts:506-527`).

### `orchestrator:queue:in-flight-items` — SET

Existing. Membership: itemKey. Modified by `enqueueIfAbsent` (SADD), `complete` / `release` (SREM). The new `RECLAIM_ORPHAN_SCRIPT` also SREMs on reclaim.

### `orchestrator:queue:pending` — SORTED SET

Existing. Member: serialized item JSON. Score: priority. The new `RECLAIM_ORPHAN_SCRIPT` ZADDs the reclaimed item with `queueReason: 'resume'` and priority 0.

## Validation Rules

### `maxRunDurationMs`

- Zod: `z.number().int().min(60_000).default(1_800_000)`.
- Rationale: min 60,000 ms (1 min) — anything smaller has no operational meaning (healthy dispatches take seconds to minutes). Default 30 min per Q1=A.

### `RECLAIM_ORPHAN_SCRIPT` argument shape

Enforced at the client boundary (`RedisQueueAdapter.reapOrphanClaims` construction):

- `KEYS[1]` — claimed hash key (`orchestrator:queue:claimed:<workerId>`)
- `KEYS[2]` — heartbeat key (`orchestrator:worker:<workerId>:heartbeat`)
- `KEYS[3]` — in-flight SET key (`orchestrator:queue:in-flight-items`)
- `KEYS[4]` — pending sorted-set key (`orchestrator:queue:pending`)
- `ARGV[1]` — itemKey (`<owner>/<repo>#<issue>`)
- `ARGV[2]` — workerId (opaque; used only for logging inference)
- `ARGV[3]` — `now` epoch-ms (string; script parses to number)
- `ARGV[4]` — grace-window ms (string; default `2 × heartbeatCheckIntervalMs`)
- `ARGV[5]` — resume priority score (string; `getPriorityScore('resume')` = 0)
- `ARGV[6]` — pre-serialized reclaim item JSON (with `attemptCount++`, `queueReason: 'resume'`, preserved `enqueuedAt` and `metadata`)

Return codes:
- `0` — no-op (nothing to reclaim; claim hash field absent — double-dispatcher case)
- `1` — reclaimed
- `2` — heartbeat re-appeared (US2)
- `3` — within grace window (FR-005)

### `ReclaimedItem.ageMs`

Derived server-side impossible (Lua can't call `Date.now`). Derived client-side after script returns `1`: `ageMs = now - parseInt(payload.enqueuedAt as Date)`.

## Relationships

```
DispatchConfig.maxRunDurationMs
        │
        ├──►  RedisQueueAdapter.enqueueIfAbsent (drop-log severity dispatch)
        │        │
        │        └──► classifyDropSeverity(itemKey, ageMs, threshold, state)
        │
        ├──►  InMemoryQueueAdapter.enqueueIfAbsent (drop-log severity dispatch)
        │        │
        │        └──► classifyDropSeverity(itemKey, ageMs, threshold, state)
        │
        └──►  {PrFeedback, MergeConflict, ClarificationAnswer, Label}MonitorService
                 (drop-log severity dispatch via classifyDropSeverity)


WorkerDispatcher.reaperLoop  ──►  RedisQueueAdapter.reapOrphanClaims
                                        │
                                        └──►  RECLAIM_ORPHAN_SCRIPT (Lua, per orphan)
                                                 │
                                                 ├──►  EXISTS heartbeat → abort (US2)
                                                 ├──►  now - enqueuedAt < grace → abort (FR-005)
                                                 └──►  SREM in-flight + ZADD pending + HDEL/DEL claimed
```

## State Machine — one itemKey through the reclaim path

```
[healthy claim held]                claim hash + heartbeat + in-flight SET member
        │
        │ worker dies (SIGKILL / OOM / dispatcher replace)
        ▼
[orphaned claim, heartbeat alive]   claim hash + heartbeat still TTL>0 + in-flight SET member
        │
        │ heartbeatTtlMs elapses (default 30s)
        ▼
[orphaned claim, heartbeat gone]    claim hash + no heartbeat + in-flight SET member
        │                            *** THIS IS THE WEDGE STATE ***
        │
        │ reaperLoop cycle fires (heartbeatCheckIntervalMs default 15s)
        │ RedisQueueAdapter.reapOrphanClaims → RECLAIM_ORPHAN_SCRIPT
        │
        ▼
[reclaimed]                          no claim hash + no heartbeat + no in-flight SET member
                                     + pending SET has item with queueReason='resume', attemptCount++
        │
        │ next claim() poll picks up the reclaimed item ahead of new work (priority 0)
        ▼
[healthy claim held again]           new claim hash + new heartbeat + in-flight SET member
```

Total wedge duration upper bound: `heartbeatTtlMs (30s) + heartbeatCheckIntervalMs (15s) + reclaim latency ≈ 45s` — matches SC-005's `≤ 2 × heartbeatCheckIntervalMs` target.
