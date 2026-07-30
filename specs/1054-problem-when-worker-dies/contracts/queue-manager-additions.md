# Contract — `QueueManager` interface additions

Two new methods on `packages/orchestrator/src/types/monitor.ts:256-293` `QueueManager` interface. Both adapters (`RedisQueueAdapter`, `InMemoryQueueAdapter`) must implement.

## `reapOrphanClaims(now?: number): Promise<ReapReport>`

**Purpose**: Redis-side reap sweep. Reclaims claims whose owning worker's heartbeat is absent. Called from `WorkerDispatcher.reaperLoop` on the `heartbeatCheckIntervalMs` cadence.

**Semantics**:

- Iterate all `orchestrator:queue:claimed:*` keys (`SCAN`, not `KEYS`).
- For each `<workerId>` key, iterate its fields (`HGETALL`). Each field is `itemKey → payloadJSON`.
- For each `(workerId, itemKey, payload)` triple:
  - Outer check: `EXISTS orchestrator:worker:<workerId>:heartbeat` → if `1`, skip (fast path, no script invocation).
  - Compute `ageMs = now - Date.parse(payload.enqueuedAt)`.
  - Invoke `RECLAIM_ORPHAN_SCRIPT` (see [`reclaim-orphan-script.md`](reclaim-orphan-script.md)) with `[claimedKey, heartbeatKey, IN_FLIGHT_KEY, PENDING_KEY]` + `[itemKey, ageMs, graceWindowMs, resumePriority, reclaimItemJSON]`.
  - Interpret return:
    - `0` — no-op (claim vanished mid-iteration; treat as skipped, do not increment reclaim/race/grace counters).
    - `1` — reclaimed. Append to `ReapReport.reclaimed`. Emit FR-008 `warn` log. Cleanup: `dropLogState.delete(itemKey)`.
    - `2` — heartbeat re-appeared. Increment `ReapReport.skippedRaceReappeared`.
    - `3` — within grace window. Increment `ReapReport.skippedGraceWindow`.
- `ReapReport.scanned` counts the total number of `(workerId, itemKey)` pairs inspected (matches the outer HGETALL total).
- Grace window: `graceWindowMs = 2 × config.heartbeatCheckIntervalMs` per FR-005. Constructor arg or accessed via the constructor-injected `DispatchConfig`.
- `now` default: `Date.now()`. Parameterized for test determinism.

**Return**: `ReapReport` (see [`data-model.md`](../data-model.md#reapreport--new-type)). Never throws; on any Redis error, logs `warn` and returns the partial report accumulated so far.

**Cadence**: called by dispatcher on `heartbeatCheckIntervalMs` (default 15s).

**In-memory implementation**: no-op returning `{ scanned: 0, reclaimed: [], skippedRaceReappeared: 0, skippedGraceWindow: 0 }` — per FR-011 / Q5=C (in-memory process death is total, no orphan can survive).

## `hasInFlightAge(itemKey: string): Promise<number | null>`

**Purpose**: Observability accessor. Returns the age in ms of the given itemKey's in-flight entry, so the four monitor sites can compute `ageMs` for the drop-log severity dispatcher.

**Semantics** (Redis adapter):

- `SCAN orchestrator:queue:claimed:*`.
- For each claimed key, `HGET <claimedKey> <itemKey>`.
- First hit: parse payload, return `Date.now() - Date.parse(payload.enqueuedAt)`.
- No hit across all claim keys: return `null` (not in flight — or in the pending set but never claimed; monitor should not have called us).
- Any transport error: log `warn`, return `null`.

**Semantics** (in-memory adapter):

- Iterate `this.claimed` Map values, find itemKey, return `Date.now() - Date.parse(payload.enqueuedAt)` or `null` if not found.
- Also iterate `this.pending` array — items in pending have not been claimed yet, but they still count as in-flight per the in-flight-set semantic. Return `Date.now() - Date.parse(pending[i].enqueuedAt)` for the pending case.
- (For consistency the Redis adapter should also cover the pending case — but in Redis the pending set is a ZSET of serialized JSON strings, so iterating it costs the same as iterating claimed. Handled in the same `SCAN`-like loop over `ZRANGE`. Deferred to implementation: if the monitor's ageMs shows null for a pending-only item, the monitor falls back to `severity: 'info'` fail-safe, so this is a non-critical accuracy loss.)

**Return**: `Promise<number | null>`. Never throws.

**Callers**: `pr-feedback-monitor-service.ts:428`, `merge-conflict-monitor-service.ts:186`, `clarification-answer-monitor-service.ts:240`, `label-monitor-service.ts:361`.

**Non-goals**:
- Not used on the enqueue hot path — the adapter's own `enqueueIfAbsent` already has the payload in scope from the outer `HGETALL` (or in-memory Map) and passes `ageMs` directly to `classifyDropSeverity`.
- Not a public export from the package's `index.ts` — it's an internal contract between the adapter and the monitor sites.

## Reap cycle log line (dispatcher-side)

`WorkerDispatcher.reaperLoop` logs the reap report at `info` when nonzero:

```ts
if (report.reclaimed.length > 0 || report.skippedRaceReappeared > 0 || report.skippedGraceWindow > 0) {
  this.logger.info(
    {
      event: 'reap-orphan-claims',
      scanned: report.scanned,
      reclaimed: report.reclaimed.length,
      skippedRaceReappeared: report.skippedRaceReappeared,
      skippedGraceWindow: report.skippedGraceWindow,
    },
    'Reaper cycle complete (Redis-side)',
  );
}
```

Per-reclaim FR-008 `warn` line (emitted by the adapter, not the dispatcher):

```ts
this.logger.warn(
  {
    event: 'orphan-claim-reclaimed',
    workerId: reclaimedItem.workerId,
    itemKey: reclaimedItem.itemKey,
    ageMs: reclaimedItem.ageMs,
    attemptCountBefore: reclaimedItem.attemptCountBefore,
    attemptCountAfter: reclaimedItem.attemptCountAfter,
    reason: 'orphaned-claim-no-heartbeat',
  },
  'Reclaimed orphaned queue claim (worker heartbeat absent)',
);
```
