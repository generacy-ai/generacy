# Feature Specification: Periodic in-flight/claim reconciliation to close #1054 finding 6 residue

**Branch**: `1058-follow-up-1054-pr` | **Date**: 2026-07-29 | **Status**: Draft | **Issue**: [#1058](https://github.com/generacy-ai/generacy/issues/1058)

## Summary

`RedisQueueAdapter.reapOrphanClaims()` (`packages/orchestrator/src/services/redis-queue-adapter.ts:573`) is candidate-set-driven by `orchestrator:queue:claimed:*` keys — it iterates worker claim hashes and reclaims entries whose worker heartbeat has expired. This closes the incident-reported wedge shape from #1054 (heartbeat-ABSENT candidates in a live claim hash), but leaves a residual gap the reviewer of PR #1056 explicitly called out (finding 6): the sweep has no path to discover an `itemKey` that exists in `orchestrator:queue:in-flight-items` **without** a matching claim-hash entry. If a `claimed:<workerId>` hash entry is ever removed — memory pressure eviction, a bug that `HDEL`s without a paired `SREM IN_FLIGHT_KEY`, an out-of-band `DEL` during operator triage (the exact 2026-07-28 15:18Z trigger on tetrad-development) — while the in-flight SET member survives, the itemKey becomes wedged in-flight forever. Every subsequent `enqueueIfAbsent()` for that issue is silently dropped by `ENQUEUE_IF_ABSENT_SCRIPT`'s `SISMEMBER` guard, and no code path exists to un-wedge it. This spec adds a periodic reconciliation pass that computes `orphaned = in-flight-items \ (pending ∪ claimed)` and `SREM`s the residue from `IN_FLIGHT_KEY`, plus a structured log line so operators can observe when reconciliation fires. The current code already advertises this gap in a `#1054 finding 6 — KNOWN RESIDUE` docstring on `reapOrphanClaims` (`redis-queue-adapter.ts:566-571`) that names this issue as the tracker.

## Problem

`RedisQueueAdapter` maintains an invariant `in-flight = pending ∪ claimed` — every `itemKey` present in `IN_FLIGHT_KEY` is expected to be reachable either as a pending ZSET member (`orchestrator:queue:pending`) or as a claim-hash entry (`orchestrator:queue:claimed:<workerId>` under field `itemKey`). Every operation preserves the invariant by pairing SET mutations with pending/claimed mutations under Lua atomicity: `ENQUEUE_IF_ABSENT_SCRIPT` and the #1060/#1065 `enqueue()` add to both together, `CLAIM_SCRIPT` deliberately does NOT `SREM` on claim (in-flight = pending ∪ claimed by design), `RELEASE_SCRIPT` `SREM`s only on the dead-letter branch, `RECLAIM_ORPHAN_SCRIPT` re-pends without `SREM`, and `complete()` `SREM`s alongside `HDEL`.

The invariant can nevertheless be violated by state that arrives **outside** any of these code paths:

1. **Redis memory-pressure eviction.** Under `maxmemory-policy` values that can evict individual hash fields or whole keys (`allkeys-lru`, `volatile-lru` if the claim hash has a TTL, `allkeys-random`), a `claimed:<workerId>` hash entry can vanish without the corresponding `SREM IN_FLIGHT_KEY` firing. The in-flight SET member survives, but nothing in the codebase can find or clean it — `reapOrphanClaims` iterates `claimed:*` keys and never sees the SET.
2. **Bug drift over time.** Any future refactor that adds an `HDEL` on the claim hash without a paired `SREM` — even briefly, on a rarely-hit code path — leaves the same residue permanently. There is no compensating garbage-collector.
3. **Out-of-band operator action.** The 2026-07-28 15:18Z incident on tetrad-development triggered a variant of this shape: during `#1054` debugging, an operator issued a `DEL orchestrator:queue:in-flight-items` to unwedge stuck items, leaving claim hashes populated with no matching SET membership. The mirror-image state (SET populated without matching claim) reaches the same functional result — `enqueueIfAbsent` cannot proceed because `SISMEMBER` returns 1, but no worker is actually claiming the item and no reaper can find it.

### Failure sequence (memory-eviction path — most realistic post-fix)

1. `enqueue()` or `enqueueIfAbsent()` places `itemKey = "owner/repo#N"` in pending; `SADD IN_FLIGHT_KEY "owner/repo#N"` fires atomically.
2. `CLAIM_SCRIPT` moves the item to `claimed:<worker-A>` under field `"owner/repo#N"`. `IN_FLIGHT_KEY` membership preserved by design.
3. Redis approaches `maxmemory`. Eviction policy selects the `claimed:<worker-A>` hash key (or its `"owner/repo#N"` field, depending on policy). The claim entry disappears. `IN_FLIGHT_KEY` retains the SET member.
4. Worker A's heartbeat continues (if the worker is alive) or times out (if it died). Either way, `reapOrphanClaims` scans `claimed:*` keys, does not see the evicted entry, and does not reclaim.
5. Any monitor (or the `process` intake path) calls `enqueueIfAbsent({ itemKey: "owner/repo#N", ... })`. `SISMEMBER IN_FLIGHT_KEY "owner/repo#N"` returns 1. The enqueue is dropped with a `Dropping enqueueIfAbsent (item already in flight)` info log.
6. The issue is silently stuck. No worker is processing it, no reaper will reclaim it, and no monitor can enqueue it. Operator intervention is required (`SREM orchestrator:queue:in-flight-items owner/repo#N`) or the item stays wedged for the process lifetime of the Redis instance.

### Ruled out

- **Not solvable by extending `reapOrphanClaims`'s existing sweep.** `reapOrphanClaims` iterates `claimed:*` keys — it starts from the claim side. The residue by definition has no claim entry to iterate from. A separate reconciliation direction (start from `IN_FLIGHT_KEY`, subtract `pending ∪ claimed`) is required.
- **Not solvable by tightening `CLAIM_SCRIPT` to `SREM` on claim.** The existing `CLAIM_SCRIPT` non-`SREM` behaviour is load-bearing (see `redis-queue-adapter.ts:82-90`) — the SET indexes `pending ∪ claimed`, so a claimed item MUST retain SET membership for `enqueueIfAbsent`'s dedupe to reject a concurrent re-enqueue. Removing on claim would recreate the exact double-dispatch race #1060 fixed.
- **Not solvable by adding TTL to `IN_FLIGHT_KEY` members.** Redis SETs do not support per-member TTL; the alternative (per-key `SET`-with-TTL storage) is a much larger refactor cited as out-of-scope in #1054/PR #1056.
- **Not solvable by hardening `maxmemory-policy`.** Operators can and do configure whatever policy they need; the queue adapter cannot assume a specific policy. The reconciliation is the compensating mechanism for any policy that permits mid-key eviction.
- **Not solvable by moving `enqueueIfAbsent` off `SISMEMBER`.** The `SISMEMBER` guard is the correctness mechanism for the dominant intake paths (#1060). Loosening it would reintroduce the double-dispatch race.

### Relationship to #1054 (PR #1056) and #1060 (PR #1065)

Complementary, not overlapping. PR #1056 added `RECLAIM_ORPHAN_SCRIPT` to handle heartbeat-absent candidates discoverable from the claim-hash side; that's the correct primary mechanism for the observed #1054 incident. PR #1065 (#1060 fix) restored the `SADD IN_FLIGHT_KEY` co-atomicity on `enqueue()`, closing the primary intake path's dedupe hole. This spec closes the third and last known reachable gap: items that end up in the SET without any claim-hash trail. The three fixes together make the `in-flight = pending ∪ claimed` invariant self-repairing rather than only assertion-based. Note that PR #1056's `KNOWN RESIDUE` docstring on `reapOrphanClaims:566-571` already names this issue (#1058) as the tracker for the residue; landing this spec removes the residue and the docstring updates accordingly.

## User Stories

### US1: Wedged in-flight residue is self-repairing

**As** an operator running the orchestrator cluster,
**I want** in-flight-SET entries with no matching pending or claim entry to be discovered and cleaned up automatically,
**So that** an evicted claim hash, an operator's out-of-band `DEL`, or a future bug that drops a `SREM` cannot silently strand issues in a permanently-dropped state.

**Acceptance Criteria**:
- [ ] After a state is produced where `IN_FLIGHT_KEY` contains an `itemKey` that is not in pending (no ZSET member with that itemKey) and not in any claim hash (no `HGET claimed:* itemKey` hits), the next reconciliation cycle `SREM`s the itemKey from `IN_FLIGHT_KEY`.
- [ ] After the `SREM`, a subsequent `enqueueIfAbsent({ itemKey })` succeeds (returns 1, adds to pending, adds to IN_FLIGHT_KEY) — the issue is unstuck and can be dispatched.
- [ ] The reconciliation is a no-op on the healthy invariant state (`in-flight == pending ∪ claimed`). No spurious `SREM`s, no impact on pending ZSET members, no impact on claim hashes.

### US2: Reconciliation is observable

**As** an operator or on-call responder,
**I want** each reconciliation `SREM` to emit a structured log line naming the itemKey, its age since first seen, and the reason for removal,
**So that** I can distinguish "reconciliation quietly repaired a bug" from "the reconciliation is firing suspiciously often — investigate root cause".

**Acceptance Criteria**:
- [ ] Each `SREM` from `IN_FLIGHT_KEY` during reconciliation emits a `warn`-level structured log line matching the shape used by `reapOrphanClaims`'s `orphan-claim-reclaimed` event: `{ event: 'orphan-in-flight-reconciled', itemKey, ageMs, reason: 'in-flight-no-pending-no-claim' }`.
- [ ] The full reconciliation cycle emits a summary log line at the end (matching the `reap-orphan-claims` event pattern in `worker-dispatcher.ts:600-609`), reporting `{ event: 'reconcile-in-flight', scanned, reconciled, skippedRaceReappeared }`. `scanned` is the number of `IN_FLIGHT_KEY` members examined; `reconciled` is the number `SREM`'d; `skippedRaceReappeared` is items that re-appeared in pending or claimed between the read and the write (see FR-003's TOCTOU note).
- [ ] If reconciliation finds zero residue on a cycle, no summary log fires (matches `reapOrphanClaims`'s conditional summary at `worker-dispatcher.ts:594-599`) — avoids per-cycle noise on the healthy path.

### US3: Reconciliation composes safely with concurrent traffic

**As** a queue implementation,
**I want** reconciliation to be safe against a concurrent `enqueueIfAbsent`, `enqueue`, `claim`, or `RECLAIM_ORPHAN_SCRIPT` firing on the same itemKey between the "compute residue" and "SREM" phases,
**So that** the reconciliation cannot itself introduce a new race (removing an SET member that just became legitimately populated between the two operations).

**Acceptance Criteria**:
- [ ] The residue computation and the `SREM` for each residue item are folded into a single Lua script invocation, so that another concurrent `SADD` (from `enqueue`/`enqueueIfAbsent`) or claim/reclaim between the two phases is impossible.
- [ ] If concurrent traffic re-populates pending or claimed for an itemKey between the initial residue scan and the per-item Lua invocation, the Lua script re-checks membership in pending and claimed atomically and skips the `SREM` (counted as `skippedRaceReappeared` in the summary).
- [ ] Reconciliation never modifies pending, claim hashes, heartbeat keys, or `_dedup:*` — only `IN_FLIGHT_KEY` members.

### US4: Reconciliation cadence is bounded and non-disruptive

**As** the reaper loop owner,
**I want** the reconciliation cadence to be predictable and not add meaningful load,
**So that** enabling it does not degrade cluster performance and its operational footprint is predictable.

**Acceptance Criteria**:
- [ ] Reconciliation runs on a documented cadence — either co-located with the existing `reaperLoop` in `worker-dispatcher.ts:569-615` (every `heartbeatCheckIntervalMs`, default 30 s) or on a longer independent cadence.
- [ ] Reconciliation uses `SSCAN` on `IN_FLIGHT_KEY` with a bounded `COUNT` per batch (mirrors `reapOrphanClaims`'s `SCAN ... COUNT 100` pattern at `redis-queue-adapter.ts:588-594`) so that a large SET does not block Redis.
- [ ] Reconciliation is error-tolerant: a Redis transport failure mid-sweep is logged at `warn` and the cycle returns a partial report; the next cycle retries. Mirrors `reapOrphanClaims`'s error contract exactly.
- [ ] Reconciliation is disabled by construction on `InMemoryQueueAdapter` — the in-memory adapter tracks in-flight, pending, and claimed as first-class data structures that cannot diverge; there is no residue to reconcile.

### US5: Regression coverage guards the fix

**As** a future engineer refactoring the queue adapter,
**I want** a regression test that fails if the reconciliation is deleted, disabled, or scoped incorrectly,
**So that** the residue-repair guarantee is enforced by CI, not by scripture.

**Acceptance Criteria**:
- [ ] A regression test constructs the wedge state directly (e.g., `SADD IN_FLIGHT_KEY test-item` without corresponding pending or claim), runs reconciliation, and asserts the SET member is `SREM`'d.
- [ ] A regression test asserts the healthy-state no-op: with a legitimate `pending → claim → complete` cycle, reconciliation makes zero `SREM` calls and leaves the SET unchanged at each stage.
- [ ] A regression test asserts the TOCTOU safety property: reconciliation initiated against an itemKey that has legitimate pending or claim membership at the moment the Lua fires does not `SREM` the item (increments `skippedRaceReappeared` instead).
- [ ] Deleting the reconciliation invocation from the reaper loop causes at least one of the tests above to fail.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a new method `reconcileInFlight(now?: number): Promise<ReconcileReport>` on `RedisQueueAdapter`. It scans `IN_FLIGHT_KEY` via `SSCAN` (bounded `COUNT` per batch — mirror `reapOrphanClaims`'s `SCAN ... COUNT 100` at `redis-queue-adapter.ts:588-594`). For each `itemKey` in the SET, invoke a new Lua script `RECONCILE_IN_FLIGHT_SCRIPT` that atomically: (a) checks whether any pending ZSET member's parsed itemKey equals the target itemKey, (b) checks whether any claim hash (`SCAN`-derivable at read time OR a `KEYS claimed:*` if the sweep runs infrequently enough to justify) has a field matching the target itemKey, (c) if neither, `SREM IN_FLIGHT_KEY itemKey` and return `reconciled`; (d) if either matches, return `skipped-race-reappeared`. The `ReconcileReport` shape is `{ scanned: number, reconciled: number, skippedRaceReappeared: number }`, matching `ReapReport`'s idiom. **Implementation note**: iterating pending inside a Lua script requires either `ZRANGE` full pending + JSON-parse each member's `itemKey` (O(pending-size) per script call — expensive at scale) or maintaining a `pending-item-keys` SET as a mirror index (added by `enqueue`/`enqueueIfAbsent` scripts, removed by `CLAIM_SCRIPT`) — the mirror is cheaper but touches FR-006's out-of-scope guardrail. **Preferred approach**: read pending and claimed itemKey sets client-side once per sweep, then run per-itemKey Lua that operates against a passed-in "known-orphan" candidate — the per-item script only needs to re-check by looking up in the pre-computed candidate SET stored in a scratch key. Concrete design deferred to `/plan`; the correctness contract (FR-002/FR-003) constrains it, not this note. | P1 | Direct implementation of the reconciliation. See FR-006 for the compensating in-scope/out-of-scope split. |
| FR-002 | The residue check must correctly compute `orphaned = in-flight-items \ (pending ∪ claimed)` where `pending` and `claimed` are read from the *actual queue state at the time of the check*, not from a stale snapshot. If an itemKey re-appears in pending or claimed between the SSCAN read and the per-item Lua invocation, the Lua script's atomic re-check must skip the `SREM` and count it as `skippedRaceReappeared`. Reconciliation must NEVER `SREM` an itemKey that has legitimate pending or claim membership at the moment the `SREM` would fire. | P1 | US3. Correctness under concurrent traffic. Any implementation that `SREM`s based on the initial SSCAN snapshot without re-checking is unsafe — `enqueue` can fire between the snapshot and the `SREM`, and the resulting state (legitimate SET member removed) is worse than the residue this spec addresses. |
| FR-003 | The reconciliation loop cadence is co-located with the existing `worker-dispatcher.ts::reaperLoop` (at `heartbeatCheckIntervalMs`, default 30 s), invoked immediately after `reapOrphanClaims` on the same iteration. Rationale: `reapOrphanClaims` mutates the claim-hash side; running reconciliation immediately after ensures the residue check sees a coherent post-reap state. Same `.catch(...)` error-tolerance envelope as `reapOrphanClaims` invocation at `worker-dispatcher.ts:588-593`. | P1 | Simpler than a second independent loop; reuses the reaper cadence's proven envelope; avoids double the AbortSignal / graceful shutdown wiring. Independent cadence (per US4-AC1's "or on a longer independent cadence") is a possible /plan alternative if the co-located approach is measured too expensive; the acceptance criterion covers both. |
| FR-004 | Each `SREM` emits a `warn`-level structured log line matching `orphan-claim-reclaimed`'s shape: `{ event: 'orphan-in-flight-reconciled', itemKey, ageMs, reason: 'in-flight-no-pending-no-claim' }`. `ageMs` is derived from the `enqueuedAtCache` (`redis-queue-adapter.ts:490-500`) — the cache is populated by `enqueue`/`enqueueIfAbsent`/`RECLAIM_ORPHAN_SCRIPT` and by `reapOrphanClaims`'s per-worker `hgetall` scan (`redis-queue-adapter.ts:657-663`). If the itemKey is not in the cache (long-lived residue that predates any cache-populating event this process lifetime), emit with `ageMs: null`. The full cycle emits `{ event: 'reconcile-in-flight', scanned, reconciled, skippedRaceReappeared }` at the same site as `reap-orphan-claims` in `worker-dispatcher.ts:600-609`, gated by `reconciled > 0 || skippedRaceReappeared > 0` so a fully healthy cycle produces zero log noise. | P2 | US2. Log-shape parity with reap events lets operators query for the two shapes together as "queue self-repair" activity. |
| FR-005 | Add `reconcileInFlight` to the `QueueManager` interface (`packages/orchestrator/src/services/queue-manager.ts` or wherever the shared adapter interface lives — verify at /plan). `InMemoryQueueAdapter.reconcileInFlight()` implementation is a no-op returning `{ scanned: this.inFlightSet.size, reconciled: 0, skippedRaceReappeared: 0 }` with a comment explaining why (in-memory adapter maintains the invariant by construction — pending/claimed/in-flight are first-class Map/Set/Map fields, not derived from each other). | P2 | US4-AC4. Preserves cross-adapter parity contract; no adapter callers need conditional dispatch. |
| FR-006 | Zero change to `ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RELEASE_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, or any existing method on `RedisQueueAdapter`. In particular, do NOT add a new `pending-item-keys` mirror SET or otherwise change how pending/claimed are structured. The fix is additive — one new method, one new Lua script, one new interface entry, one wiring line in `worker-dispatcher.ts`'s reaper loop. Rationale: any structural change to the existing scripts risks new races or regressions in the healthy path; the reconciliation exists precisely to compensate for state divergence, so making the primary structures more complex to accommodate it defeats the purpose. | P1 | Bounds blast radius. Preserves FR-001's implementation flexibility while forbidding a whole class of "helper" changes that would require touching every existing script. |
| FR-007 | Update the `#1054 finding 6 — KNOWN RESIDUE` docstring at `redis-queue-adapter.ts:566-571` on `reapOrphanClaims` to reflect that the residue is now closed by `reconcileInFlight`, and cross-reference the new method. Preserve the historical context — future readers may want to understand why the two-directional sweep exists rather than a single unified sweep. | P3 | Documentation hygiene. Keeps `reapOrphanClaims` honest about its scope. |
| FR-008 | Regression test coverage. A parameterized test suite (both adapters; in-memory case is trivially the no-op assertion) covers: (a) wedge-state repair (direct `SADD` without pending/claim → reconciliation `SREM`s), (b) healthy-state no-op (full `enqueue → claim → complete` cycle → zero `SREM`s), (c) TOCTOU safety (concurrent `enqueueIfAbsent` for the target itemKey between residue scan and Lua invocation → no `SREM`, `skippedRaceReappeared` incremented), (d) log-shape assertion (test spy on logger asserts the FR-004 event/field shape). Redis-adapter case uses real Redis (matches the established `redis-queue-adapter.*.test.ts` pattern — mocked SET/HASH would not catch a mis-issued `SREM` command shape). | P1 | US5. Direct assertion of the reconciliation guarantee, not implied by scripture in surrounding scripts. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Wedged in-flight residue survivable across a reaper cycle | 0 items | Test: construct wedge state (`SADD IN_FLIGHT_KEY test-item` with no pending/claim), advance one reaper cycle → assert `SISMEMBER IN_FLIGHT_KEY test-item` returns 0 and a subsequent `enqueueIfAbsent(test-item)` succeeds. |
| SC-002 | Spurious `SREM`s during a healthy `enqueue → claim → complete` cycle | 0 | Test: run the full cycle, spy on all Redis commands issued by `reconcileInFlight` during the cycle → assert zero `SREM IN_FLIGHT_KEY` calls. |
| SC-003 | Data-race-produced spurious `SREM` under concurrent enqueue traffic | 0 | Test: schedule `reconcileInFlight` and `enqueueIfAbsent(itemKey)` to race on the same itemKey → assert either the enqueue's `SADD` completed before the `SREM` (and the item is legitimately pending after) or the reconciliation skipped the item (counted as `skippedRaceReappeared`). Never a state where the SET is empty and the item is pending, or vice versa. |
| SC-004 | New Redis operations per reaper cycle on a healthy cluster (no residue) | 1 `SSCAN` batch + client-side set-difference (zero Lua invocations) | Measurement: `redis-cli MONITOR` during a healthy reaper cycle → assert one `SSCAN` cursor round-trip per batch, and zero `EVAL`/`EVALSHA` for reconciliation when no residue is found. |
| SC-005 | Wedge repair latency | ≤ `2 × heartbeatCheckIntervalMs` from wedge creation to reconciliation | Test: create wedge, sleep 60 s (default `heartbeatCheckIntervalMs = 30 s` × 2 for cycle boundary safety), assert wedge is gone. Bounds worst-case operator wait when a bug or eviction produces new residue. |
| SC-006 | Regression re-appearance of the residue gap under refactor | Fails CI | Delete the `reconcileInFlight` invocation from `reaperLoop` → at least one FR-008 test fails; delete the `SREM` from the Lua script → at least one FR-008 test fails. |
| SC-007 | Cross-adapter parity | 0 divergences | Parameterized test asserts `reconcileInFlight` exists on both adapters, returns a `ReconcileReport`-shaped result, and produces the expected outcomes for the four FR-008 scenarios. |

## Assumptions

- The `KNOWN RESIDUE` docstring at `packages/orchestrator/src/services/redis-queue-adapter.ts:566-571` names this issue (#1058) as the tracker. The scope described there — "periodic `in-flight-items \ (pending ∪ claimed)` reconciliation" — is the sole scope of this spec. Any broader queue redesign is deferred.
- The `worker-dispatcher.ts::reaperLoop` (`worker-dispatcher.ts:569-615`) is the natural host for the periodic invocation. It already owns `heartbeatCheckIntervalMs` cadence, AbortSignal-driven graceful shutdown, and error-tolerant `.catch()` envelope for Redis operations. Adding the reconciliation call after `reapOrphanClaims` reuses that infrastructure verbatim.
- `RedisQueueAdapter` already uses `EVAL`/`EVALSHA` via `defineCommand` for five Lua scripts (`CLAIM_SCRIPT`, `RELEASE_SCRIPT`, `ENQUEUE_IF_ABSENT_SCRIPT`/`ENQUEUE_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `REQUEUE_FOR_RESUME_SCRIPT`). Adding a sixth follows the established `ensureXCommand()` guard pattern (`redis-queue-adapter.ts:243-250`) with no new infrastructure.
- The `enqueuedAtCache` (`redis-queue-adapter.ts:490-500`) is the source of `ageMs` on the FR-004 log line. When the cache lacks an entry for a residue itemKey (long-lived residue predating any cache-populating event this process lifetime — plausible under memory eviction if the eviction fires before the cache was warmed), the log emits `ageMs: null` rather than an inaccurate default; operators can still act on the itemKey. This mirrors `reapOrphanClaims`'s handling of missing `claimedAt` at `redis-queue-adapter.ts:646-654`.
- The composition with PR #1056 (`RECLAIM_ORPHAN_SCRIPT`, merged `afab7d58`) is additive. `reapOrphanClaims` continues to handle the claim-hash-populated side (heartbeat-absent workers); `reconcileInFlight` handles the SET-populated side (no claim-hash entry). Together they make the two-sided invariant self-repairing.
- The composition with PR #1065 (#1060 fix, merged `fbcf85fb`) is additive. The `enqueue()` co-atomicity fix from #1065 ensures the primary intake path does not produce residue via routine operation; this spec compensates for residue produced by non-routine paths (eviction, out-of-band operator action, future bug). The two fixes protect different classes of failure and both are load-bearing.
- The composition with PR-in-flight #1069 (atomic `release()` / `requeueForResume()` — merged `9bfe5afc`) is additive. #1069 closed a TOCTOU race between `release`/`requeue` and `RECLAIM_ORPHAN_SCRIPT` that could produce a *different* duplicate-pending-member shape; that fix is orthogonal to residue-in-SET.
- The primary trigger post-fix is Redis memory-pressure eviction under `maxmemory-policy` values that permit hash-field or hash-key eviction. Operator-issued `DEL` (the observed 2026-07-28 incident's trigger) remains reproducible manually but is expected to be rare post-fix. Future bug-introduced residue is compensated automatically.
- `SSCAN` on `IN_FLIGHT_KEY` with a bounded `COUNT` (matching `reapOrphanClaims`'s `SCAN ... COUNT 100`) is the correct primitive — `SMEMBERS` on a large SET would block Redis single-threaded execution for O(SET-size). `SSCAN`'s cursor semantics permit sweep-through-mutation without missing new members added mid-sweep (they'd be found on the next cycle at worst).
- The bug applies uniformly to every workflow (`workflow:speckit-feature`, `workflow:speckit-bugfix`, any future workflow) because the affected code path is workflow-agnostic — every workflow ultimately routes items through `RedisQueueAdapter` and the residue is a property of the SET, not the item's workflow.
- Reconciliation adds one `SSCAN` cursor round-trip per reaper cycle on a healthy cluster (no residue found → zero Lua invocations). Under a small persistent residue, one `EVAL`/`EVALSHA` per residue item per cycle. This is bounded and predictable — a bug producing large-scale residue would produce large log volume by design (each `SREM` logs) so operators would notice.
- Adding `reconcileInFlight` to the `QueueManager` interface is a public-API extension. Because the only callers are internal to the orchestrator package (the reaper loop is the sole caller) and no external package imports `QueueManager`, the change is a `patch` from a semver perspective. If any external package imports the interface at implement time, upgrade to `minor` per the CLAUDE.md changeset rules.

## Out of Scope

- **Restructuring pending/claimed storage** (per-key `SET`-with-TTL, mirror `pending-item-keys` SET, etc.). Called out as out-of-scope in #1054/PR #1056; this spec preserves that boundary. The reconciliation compensates for any diverged state without requiring the primary structures to change.
- **Handling residue in `orchestrator:queue:_dedup:<itemKey>` hashes.** The `_dedup:*` hash is an observability artifact (populated by `enqueue`, read by `getDedupKey`), not a queue-correctness structure. If it drifts, no queue behaviour changes. A separate reconciliation for `_dedup:*` is deferred.
- **Tightening `CLAIM_SCRIPT` to `SREM` on claim.** Explicitly forbidden by FR-006 — the non-`SREM` is load-bearing.
- **Enforcing a specific Redis `maxmemory-policy`.** Operators own that configuration; this spec adds the compensating mechanism, not a policy constraint.
- **Emitting a metric (Prometheus counter, gauge) for reconciliation events.** FR-004 covers structured logging, which is the current observability surface for `reapOrphanClaims` events. A metric layer is a separate initiative applying uniformly to all queue events.
- **Cloud-side alerting on the reconciliation log line.** FR-004's log-line shape is the observer surface; downstream alerting is ops-config.
- **A `/queue/reconcile` admin endpoint or CLI tool for manual invocation.** The periodic loop is the primary mechanism; operators who need to force an immediate reconciliation can restart the orchestrator (which triggers the reaper loop on its normal cadence). If a manual trigger becomes desirable later, follow-up.
- **Extending `InMemoryQueueAdapter` to track residue.** By construction, the in-memory adapter's fields (`pendingQueue`, `claimedItems`, `inFlightSet`) can only diverge under bugs in the in-memory adapter itself; there is no external process (Redis eviction, operator `DEL`) that can produce residue. FR-005's no-op implementation is sufficient.
- **Age-based severity escalation on the reconciliation log line.** #1054/PR #1056 introduced transition-edge throttling for `drop-log-helper.ts`; that mechanism is for repeated per-cycle log spam, not for one-shot reconciliation events. `warn`-level per event (FR-004) is the correct severity.
- **Reconciling `orchestrator:queue:pending` for members with malformed JSON or missing itemKey fields.** Those are separate correctness concerns (indicates a bug in the enqueue path); this spec addresses only in-flight-SET residue.

## References

- Parent issue tracker: #1054
- Parent fix PR: #1056 (`RECLAIM_ORPHAN_SCRIPT`)
- Related #1060/#1065 (`ENQUEUE_SCRIPT` co-atomicity, primary intake path)
- Related #1069 (atomic `release()` / `requeueForResume()`)
- Reviewer comment thread: PR #1056 review by @christrudelpw (finding 6)
- Docstring in current code naming this issue: `packages/orchestrator/src/services/redis-queue-adapter.ts:566-571`

---

*Generated by speckit*
