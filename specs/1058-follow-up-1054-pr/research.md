# Research — #1058 Periodic in-flight/claim reconciliation

## Scope

Research supporting the four decisions materially not fully resolved in the spec + clarifications:

1. Detection strategy (snapshot vs. authoritative Lua vs. secondary index).
2. Confirmation gate mechanism (in-memory tracker vs. Redis scratch key vs. atomic Lua re-check alone).
3. Lua script minimum surface (single-key `SISMEMBER`+`SREM` vs. multi-key snapshot re-check).
4. Boot-sweep call site (adapter constructor vs. dispatcher `start()` vs. reaperLoop first iteration).

## Decision Log

### D1: Detection is a client-side snapshot; action is two-sweep-gated

**Chosen**: Client-side snapshot detection (`SSCAN IN_FLIGHT_KEY`, `ZRANGE PENDING_KEY 0 -1` + JSON parse, `SCAN CLAIMED_KEY_PREFIX*` + `HKEYS`), client-side set-difference in memory, then gate action on the two-sweep tracker (per clarifications Q1=D).

**Alternatives considered**:

- **A: Client-side snapshot + scratch-key handoff to per-item Lua (the spec's original "preferred approach").** The Lua would take `(IN_FLIGHT_KEY, SCRATCH_KEY)` as KEYS and do an atomic re-check against the scratch snapshot before `SREM`. **Rejected**: the per-item Lua re-check confirms against the **scratch snapshot**, not against live state — atomicity against the wrong data is not a guard. Because the client-side snapshot reads `pending` and `claimed` at two different instants, an item legitimately transitioning between the two (dispatcher claim; `release()` retry) is invisible to both sides of the snapshot and gets classified as residue. The Lua re-check against the scratch atomically confirms the stale reading. A false-positive `SREM` then removes the in-flight member for a live item; the next `enqueueIfAbsent` passes its `SISMEMBER` guard and adds a second pending member — two workers on one issue, exactly the failure mode #1054/#1060/#1069 close.
- **B: Full `ZRANGE + JSON.parse` inside per-item Lua on every call.** Authoritative (Lua sees a consistent view under Redis single-threaded execution). **Rejected**: Redis is single-threaded, so an `O(pending)` script with a JSON parse per member blocks every other client for the duration — not acceptable as a steady-state cost. `cjson.decode` per-member for a pending set of 1,000 items would block Redis for milliseconds each cycle.
- **C: `SUNION` over pre-populated scratch keys in a single Lua invocation** (batch reconciliation). **Rejected**: same underlying flaw as A — atomicity against snapshot is not a guarantee against live races — plus complexity of managing scratch-key lifecycle.
- **D: Secondary index `orchestrator:queue:claimed-itemKeys` (SET of itemKeys currently in any claim hash).** **Rejected**: same reasoning as #1054's D1 rejection — adding an `SADD`/`SREM` pair to `CLAIM_SCRIPT`/`RELEASE_SCRIPT` violates FR-006 ("zero change to existing scripts") and complicates the primary intake path for a residue-repair edge case.

**Key insight (from clarifications Q1)**: detection can be sloppy and cheap when action is confirmed. A genuinely wedged item is residue permanently — it will still be there 30 seconds later. A transient artifact of the snapshot race resolves within one cycle and never gets removed. This decouples detection cost from correctness.

**Sources**: Clarifications Q1=D. `reapOrphanClaims`'s existing snapshot-with-Lua-re-check pattern at `redis-queue-adapter.ts:573-753` (that pattern works because the re-check reads live heartbeat state, not scratch state — its analog here would need to re-read pending/claimed inside Lua per candidate, which is B and unacceptable).

### D2: Confirmation gate is an in-memory `Map<itemKey, firstSeenSweepId>` on the adapter

**Chosen**: Instance-scoped `Map<string, number>` field on `RedisQueueAdapter`. First-sweep sighting inserts `{ itemKey → currentSweepId }`; second-sweep sighting with `firstSeenSweepId < currentSweepId` triggers the Lua invocation. Candidates absent from the current sweep's residue set are dropped from the Map (the transient-race case self-clears in one cycle).

**Alternatives considered**:

- **Redis scratch key `orchestrator:queue:_reconcile-tracker` (HASH of itemKey → firstSeenSweepId).** **Rejected**: cross-replica coordination not needed — each dispatcher's tracker is local anyway, and if a process crashes the boot sweep re-arms whatever residue survives. Also introduces Redis Cluster hash-slot constraints (must hash-tag with `{queue}` per Q5) and a cleanup path (scratch key never gets `DEL`'d if the process exits between insertions). The in-memory Map has none of these costs and is bounded by residue population.
- **Absent tracker, rely on atomic Lua re-check alone.** **Rejected**: covered under D1 — the Lua re-check catches concurrent re-adds inside a narrow window, but it cannot distinguish "residue that persists across time" from "transient artifact of a client-side snapshot race". The two-sweep gate is exactly the mechanism that makes that distinction (persistence across cycles = residue; single-cycle appearance = artifact).
- **Absent tracker, LRU-cache first-sweep observations.** **Rejected**: adds eviction policy complexity for a Map that is naturally bounded by residue population (an entry inserts on sweep N and is either removed on sweep N+1 by the successful `SREM` or dropped from the Map when the candidate re-appears in pending/claimed).

**Sources**: Clarifications Q1=D + Q5. Existing pattern of instance-scoped Maps on the adapter: `dropLogState` (`redis-queue-adapter.ts:328`), `enqueuedAtCache` (`:338`); on monitors: `lastUnresolvedThreadCount` (`pr-feedback-monitor-service.ts:73`), `fixerTimeoutRetryCount`.

### D3: Lua script is a minimal single-key atomic re-check (`SISMEMBER` + `SREM`), not a multi-key snapshot verifier

**Chosen**: `RECONCILE_IN_FLIGHT_SCRIPT` — `SISMEMBER KEYS[1] ARGV[1]` → if 0 return 0 (skipped-race-reappeared), else `SREM KEYS[1] ARGV[1]` return 1. `numberOfKeys: 1`. No `HGET`, no `cjson.decode`, no scratch-key comparison.

**Alternatives considered**:

- **Multi-key script that reads pending + claimed inside Lua for authoritative re-check.** **Rejected**: same as D1 option B — `O(pending)` cost per script call blocks Redis.
- **Add a `KEYS[2] = PENDING_KEY` argument for an in-script `ZRANGE + iterate` re-check.** **Rejected**: same problem — Redis single-threaded execution means the re-check dominates the script's runtime.
- **Two-key script with `KEYS[2] = scratch-pending-itemKeys` (client pre-populates once per sweep).** **Rejected**: pushes the D1 flaw into the script boundary and adds scratch-key lifecycle management for no correctness gain (the two-sweep gate already covers what a scratch re-check would provide).

**Rationale**: the two-sweep gate (D2) closes the class of races the snapshot has by construction. The Lua's role is narrow — catch the single race window where an item genuinely re-entered flight between the client-side residue computation and the specific candidate's Lua invocation. That's one `SISMEMBER` + `SREM` sequence on one key. Minimal wire; minimal Redis Cluster surface area (`numberOfKeys: 1` means zero risk of CROSSSLOT errors ever).

**Sources**: Clarifications Q1=D + spec FR-002. `ENQUEUE_IF_ABSENT_SCRIPT` at `redis-queue-adapter.ts:51-59` is the minimal-viable-script precedent (also `SISMEMBER`+`SADD`+`ZADD` with `numberOfKeys: 2`).

### D4: Boot sweep is invoked from `WorkerDispatcher.start()`, not from the adapter constructor

**Chosen**: `WorkerDispatcher.start()` (which owns the `reaperLoop` lifecycle at `worker-dispatcher.ts:111`) fires `this.queue.reconcileInFlight().catch(...)` before spawning `reaperLoop`. Fire-and-forget: `start()` returns immediately; loop's first regular sweep runs its own tracker check regardless.

**Alternatives considered**:

- **Adapter constructor fires the boot sweep in the background.** **Rejected**: tests construct many adapter instances (mocks, integration tests), and each would fire a spurious boot sweep. Also decouples the sweep from the process's lifecycle — an adapter constructed for a request-scoped operation shouldn't sweep the whole queue.
- **`reaperLoop`'s first iteration skips the initial `sleep`.** **Rejected**: two-cycle-sensitive tests would need to wait 1 × interval for the first sweep + 1 × interval for the second. Adding a "skip first sleep" flag also changes the loop shape for `reapOrphanClaims` (which currently benefits from the `sleep`-first shape — no repeated reap-then-sleep-then-reap on a healthy loop wanting to shut down). Cleaner to fire the boot sweep as a separate concern.
- **A `preflight` method on the queue interface called by whoever owns lifecycle.** **Rejected**: overkill for one call site. The `WorkerDispatcher` is already the sole entry point for periodic queue maintenance.

**Sources**: Clarifications Q2=B. `WorkerDispatcher.start()` lifecycle at `worker-dispatcher.ts:100-120` (existing pattern of spawning `reaperLoop` under an `AbortController`). Sibling boot-sweep pattern: `BootResumeService` in `packages/orchestrator/src/services/boot-resume-service.ts` (#824) fires per-service post-activation actions after wiring.

### D5: Cache invalidation semantics on `SREM` match `complete()` / dead-letter / successful reclaim exactly

**Chosen**: On successful `SREM`, invoke both `enqueuedAtCache.delete(itemKey)` AND `dropLogState.delete(itemKey)` on the adapter.

**Alternatives considered**:

- **Leave the cache; accept staleness.** **Rejected** per clarifications Q3=C. `hasInFlightAge` reads the cache first (`redis-queue-adapter.ts:494-498`); a stale entry after `SREM` returns a fabricated age on the next drop-path call — a diagnostic that confidently reports the age of something no longer in flight is the kind of thing that costs an hour during an incident.
- **Clear `enqueuedAtCache` only, leave `dropLogState`.** **Rejected**: incomplete cleanup. `dropLogState` is keyed on itemKey and remembers `lastSeverity: 'warn'`; if the same itemKey reappears in the SET later (e.g., after a fix + re-enqueue), the transition-edge logic incorrectly treats the reappearance as continuous rather than as a new wedge open. Q3=C explicitly requires both.

**Sources**: Clarifications Q3=C. `complete()` at `redis-queue-adapter.ts` (clears both). Dead-letter branch in `RELEASE_SCRIPT`'s callers. Successful reclaim in `reapOrphanClaims` at `:735`.

### D6: Per-cycle log cap (100 individual + 1 aggregate), not per-itemKey transition-edge throttling

**Chosen**: `RECONCILE_LOG_CAP = 100` individual `orphan-in-flight-reconciled` `warn` lines per cycle; beyond the cap, suppress and emit exactly one `orphan-in-flight-reconciled-batch` warn with `{ count, sampledItemKeys: [<first 10>] }`.

**Alternatives considered**:

- **Unbounded (one warn per SREM).** **Rejected**: at 10,000 residue items in one cycle the ingestion pipeline drops or rate-limits, and every other warning in the window is buried — including whichever warning explains the regression that produced the residue. Preserved from spec's "large log volume so operators would notice" intent is the *aggregate count* — that's what the batch line delivers.
- **Reuse `classifyDropSeverity` transition-edge throttling per itemKey.** **Rejected**: category error. `classifyDropSeverity` throttles per itemKey across repeated observations, but a reconciled itemKey is `SREM`'d exactly once and then ceases to exist — no second observation to throttle. Would suppress nothing while adding a Map that only grows.
- **Per-cycle summary threshold event (`{ event: 'reconcile-in-flight-excessive', reconciledCount, threshold }`) beyond a threshold, without capping individual warns.** **Rejected**: emits all 10,000 lines and adds a summary. Keeps the problem, adds a line.

**Sources**: Clarifications Q4=B.

### D7: Real-Redis integration test (not `ioredis-mock`) for the regression suite

**Chosen**: `redis-queue-adapter.reconcile-in-flight.integration.test.ts` runs against the CI-provided `redis:7` service, mirroring `redis-queue-adapter.reclaim-lua.test.ts` and `redis-queue-adapter.orphan-reclaim.test.ts`.

**Alternatives considered**:

- **`ioredis-mock` with a hand-rolled stateful mock (pattern from `redis-queue-adapter.enqueueIfAbsent.test.ts:16-125`).** **Considered**: cheaper CI cost, no service dependency. **Rejected**: the fix's failure mode is command-sequence correctness (a mis-issued `SREM` command shape) — exactly the class of bug a mock cannot catch. Same rationale that put `redis-queue-adapter.reclaim-lua.test.ts` on real Redis. Also: the tracker Map lives in the adapter instance, not Redis, so tests need to observe adapter behavior across multiple `reconcileInFlight()` invocations — a real Redis backend keeps the Redis state authoritative and lets the test spy on the Map via adapter-internal introspection or via return-value shape.
- **Mixed: unit tests with `ioredis-mock` for classification logic + one integration smoke test.** **Considered**: reasonable extension for a follow-up. Not landed in the initial fix because the classification logic is trivial (a set-difference in memory) and the integration test's assertions cover the same ground.

**Sources**: Clarifications Q4 (implicit — the pattern established by `reclaim-lua.test.ts`). Comment at `redis-queue-adapter.reclaim-lua.test.ts:22-27` on `ioredis-mock`'s fengari `cjson` limitation (though not directly relevant here — the new script uses no `cjson`).

## Sources / References

- Issue #1058: <https://github.com/generacy-ai/generacy/issues/1058> — residue-in-SET gap + spec.
- Parent tracker #1054: <https://github.com/generacy-ai/generacy/issues/1054> — original wedge incident.
- Parent fix PR #1056 (merged as `afab7d58`): `RECLAIM_ORPHAN_SCRIPT` — sibling reclaim path.
- Related PR #1065 (#1060 fix, merged as `fbcf85fb`): `ENQUEUE_SCRIPT` co-atomicity — primary intake path.
- Related PR merged as `9bfe5afc` (#1069): atomic `release()` / `requeueForResume()`.
- Reviewer comment thread: PR #1056 review by @christrudelpw (finding 6).
- Docstring in current code naming this issue: `packages/orchestrator/src/services/redis-queue-adapter.ts:566-571`.
- Existing `reapOrphanClaims` at `redis-queue-adapter.ts:573-753` — sibling sweep pattern.
- Existing `reaperLoop` at `worker-dispatcher.ts:569-615` — cadence host.
- Existing scripts as minimal-shape precedents: `ENQUEUE_IF_ABSENT_SCRIPT` (`:51-59`), `CLAIM_SCRIPT` (`:86-99`).
- Existing tracker-Map patterns: `dropLogState` (`redis-queue-adapter.ts:328`), `enqueuedAtCache` (`:338`).
- Redis docs: `SSCAN` non-blocking semantics; `EVAL`/`EVALSHA` atomicity; hash-slot rules under Redis Cluster.
- CLAUDE.md — changeset gate, no-premature-abstraction rule, comment discipline.
