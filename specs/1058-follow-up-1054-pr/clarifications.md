# Clarifications — #1058

## Batch 1 — 2026-07-29

### Q1: Lua design for residue computation
**Context**: FR-001 explicitly defers the Lua design to `/plan` and lists three candidates: (A) per-item Lua that runs `ZRANGE PENDING_KEY 0 -1` + JSON-parses each member to check for `itemKey` collisions (O(pending-size) per call, O(residue × pending) per cycle — expensive at scale); (B) client-side snapshot of pending + claimed itemKeys, staged into a scratch SET (or two scratch SETs), then per-item Lua that atomically re-checks `SISMEMBER scratch-pending` + `SISMEMBER scratch-claimed` + `SISMEMBER IN_FLIGHT_KEY` and `SREM`s only if the item is truly orphaned (spec calls this "preferred"); (C) a persistent `pending-item-keys` mirror SET — explicitly forbidden by FR-006. This decision drives per-cycle Redis command volume, scratch-key naming/TTL, and CROSSSLOT-safety of the new script's `numberOfKeys`.
**Question**: Which residue-computation strategy should `/plan` commit to?
**Options**:
- A: Client-side snapshot + scratch-key handoff to per-item Lua (spec's stated "preferred approach"). Reader responsibility: `ZRANGE PENDING_KEY 0 -1` + `SCAN claimed:*` + `HKEYS` client-side each sweep, `SADD` the union into a `orchestrator:queue:_reconcile-scratch:<sweep-id>` key with short TTL, per-item Lua takes `(IN_FLIGHT_KEY, SCRATCH_KEY)` as KEYS and does the atomic re-check.
- B: Full `ZRANGE + JSON.parse` inside per-item Lua on every call. Simpler wiring; no scratch keys, no cleanup path. Accepts O(pending × residue) worst-case per cycle.
- C: `SUNION` in a single Lua invocation over pre-populated scratch keys (batch reconciliation — all residue items handled in one script call rather than per-item).
- D: Other (please describe).

**Answer**: *Pending*

### Q2: Reconciliation cadence and startup timing
**Context**: FR-003 states the reconciliation is "co-located with the existing `worker-dispatcher.ts::reaperLoop`" (every `heartbeatCheckIntervalMs`, default 30 s). US4-AC1 leaves the door open to "a longer independent cadence". SC-005 targets `2 × heartbeatCheckIntervalMs` wedge-repair latency — that target is only meaningful if the cadence is bound to `heartbeatCheckIntervalMs`. Additionally, `reaperLoop` sleeps *before* it works (`sleep(heartbeatCheckIntervalMs)` at `worker-dispatcher.ts:571`), so on a fresh process start the first reconciliation runs one full cycle after boot — an unrepaired residue from the pre-crash state stays wedged for up to 30 s post-restart.
**Question**: What cadence should reconciliation run at, and should the first cycle fire immediately on startup?
**Options**:
- A: Co-locate with `reaperLoop` (every `heartbeatCheckIntervalMs`, default 30 s). No startup override — first cycle fires after the initial `sleep`.
- B: Co-locate with `reaperLoop`. Fire one immediate reconciliation on orchestrator startup (before the first `sleep`) so wedges from a pre-crash state are cleared as fast as possible.
- C: Independent longer cadence (e.g., every 5 min). Rationale: reconciliation compensates for rare non-routine failure modes and does not need `reaperLoop` timing; independent slower cadence reduces steady-state Redis load. Would relax SC-005 to `2 × reconciliationIntervalMs`.
- D: Configurable via `DispatchConfig` (new `reconciliationIntervalMs` field with sensible default; opt-in override for operators).

**Answer**: *Pending*

### Q3: `enqueuedAtCache` invalidation on successful `SREM`
**Context**: The `enqueuedAtCache` (`redis-queue-adapter.ts:490-500`) is cleared by `complete()`, dead-letter, and successful reclaim to bound growth. FR-004 uses the cache to compute `ageMs` on the reconciliation log line, falling back to `null` on miss. When reconciliation successfully `SREM`s a residue itemKey, the cache may or may not hold a stale entry for that key. If the cache is not cleared, a subsequent `hasInFlightAge` call for the same key would return a non-null age (from cache) even though the item is no longer in flight — a stale, misleading answer until the cache eventually evicts. If it IS cleared, we lose the source for `ageMs` should the SAME itemKey re-appear as residue in a later cycle (unlikely but possible under a persistent bug).
**Question**: On successful reconciliation `SREM IN_FLIGHT_KEY <itemKey>`, should the adapter also `enqueuedAtCache.delete(itemKey)`?
**Options**:
- A: Yes — clear the cache entry in the same operation as the `SREM`. Matches the semantics of `complete()`, dead-letter, and successful reclaim (all clear the cache when the item is no longer in flight). Accepts `ageMs: null` on any recurrence.
- B: No — leave the cache entry. Log line uses cached age (accurate for this SREM), and a stale entry is bounded in impact (`hasInFlightAge` is called only on drop paths; the SET is authoritative for `hasInFlight`).
- C: Yes AND also `dropLogState.delete(itemKey)` (matches the full cleanup semantics of successful reclaim at `redis-queue-adapter.ts:328` + `:336`). Fully returns the itemKey to first-ever-seen state.

**Answer**: *Pending*

### Q4: Log volume behavior when large-scale residue is detected
**Context**: FR-004 emits one `warn`-level `orphan-in-flight-reconciled` log per `SREM`. In the healthy-path steady state, residue is expected to be zero. But if a bug drift produces large-scale residue (e.g., 10 000 items due to a regression in a future refactor), a single reaper cycle would emit 10 000 warn lines — which is by design ("large log volume so operators would notice" — spec Assumption line ~136), but could overwhelm ingestion pipelines and mask other warnings. The related `drop-log-helper.ts` already implements transition-edge throttling (`classifyDropSeverity`) for a similar concern on the enqueueIfAbsent drop path.
**Question**: Should reconciliation implement any per-cycle log throttling for the `orphan-in-flight-reconciled` line?
**Options**:
- A: No throttling — one warn per SREM, unbounded. Matches spec's explicit "large log volume so operators would notice" intent. Simplest.
- B: Per-cycle cap (e.g., first 100 emitted individually; if more, emit an aggregate `orphan-in-flight-reconciled-batch` warn with `{ count, sampledItemKeys: [...] }` and suppress the rest).
- C: Reuse `classifyDropSeverity` transition-edge throttling per itemKey (same mechanism as the collision path — first SREM is warn, subsequent SREMs for the same itemKey during the same window are downgraded).
- D: Warn on every SREM AND emit a per-cycle summary threshold event (`{ event: 'reconcile-in-flight-excessive', reconciledCount, threshold }`) when `reconciled` exceeds a threshold in a single cycle (e.g., 100).

**Answer**: *Pending*

### Q5: Scratch-key hash-tag / CROSSSLOT strategy (only if Q1 = A or C)
**Context**: If the residue design uses a scratch key (Q1 options A or C), that scratch key MUST hash to the same Redis Cluster slot as `IN_FLIGHT_KEY`, `PENDING_KEY`, and (transitively) any `claimed:*` hash the script reads. The existing keys (`orchestrator:queue:pending`, `orchestrator:queue:in-flight-items`) don't use `{...}` hash tags — the codebase implicitly assumes single-instance Redis (or a specific slot-mapping guarantee). FR-006 forbids restructuring existing scripts. New scratch keys have design freedom: they could hash-tag with `{orchestrator:queue}` to explicitly bind them to the queue keyspace, or follow existing convention and depend on the same single-instance assumption.
**Question**: How should new scratch keys be named to be CROSSSLOT-safe?
**Options**:
- A: Follow existing convention — `orchestrator:queue:_reconcile-scratch:<sweep-id>` (no hash tag). Same single-instance assumption as the existing queue keys. Simplest; consistent.
- B: Explicitly hash-tag — `orchestrator:{queue}:_reconcile-scratch:<sweep-id>` (or migrate the whole queue keyspace to `{queue}`-tagged names as a follow-up). Future-proofs for Redis Cluster.
- C: Not applicable — Q1's answer avoids scratch keys entirely (Q1 = B).
- D: Other (please describe).

**Answer**: *Pending*
