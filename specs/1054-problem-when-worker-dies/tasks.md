# Tasks: Orphaned queue claims must be reclaimed after a worker dies without unwinding

**Input**: Design documents from `/specs/1054-problem-when-worker-dies/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md, quickstart.md, contracts/ (drop-log-helper.md, queue-manager-additions.md, reclaim-orphan-script.md)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 reclaim / US2 race safety / US3 log escalation / US4 regression test)

## Phase 1: Foundation (types + schema)

- [X] T001 [P] [US3] Add `maxRunDurationMs: z.number().int().min(60_000).default(1_800_000)` field to `DispatchConfigSchema` in `packages/orchestrator/src/config/schema.ts:164-178` (FR-012 / clarifications Q1=A). Include a JSDoc paragraph pointing at #1054 and the 30-min-vs-20-min-CLI-timeout rationale from the spec Assumptions section.

- [X] T002 [P] [US1] [US2] Widen the `QueueManager` interface in `packages/orchestrator/src/types/monitor.ts:256-293` per `contracts/queue-manager-additions.md`:
  - Add `reapOrphanClaims(now?: number): Promise<ReapReport>` method signature (JSDoc must reference FR-001 / FR-004 / US2 race safety and FR-005 grace window).
  - Add `hasInFlightAge(itemKey: string): Promise<number | null>` accessor (returns `null` on transport error or not-in-flight; used by monitor drop sites — FR-006/FR-007).
  - Export new `ReapReport` type `{ scanned: number; reclaimed: ReclaimedItem[]; skippedRaceReappeared: number; skippedGraceWindow: number }`.
  - Export new `ReclaimedItem` type `{ workerId: string; itemKey: string; ageMs: number; attemptCountBefore: number; attemptCountAfter: number }`.

## Phase 2: Shared drop-log helper (pure function)

- [X] T003 [US3] Create `packages/orchestrator/src/services/drop-log-helper.ts` per `contracts/drop-log-helper.md`. Export:
  - `DropTransitionState` type `{ lastSeverity: 'info' | 'warn' }`.
  - `DropSeverityDecision` type `{ severity: 'info' | 'warn'; isTransitionEdge: boolean; stateAfter: DropTransitionState }`.
  - `classifyDropSeverity(itemKey, ageMs: number | null, thresholdMs, state: Map<string, DropTransitionState>): DropSeverityDecision` — pure; caller owns the Map; a `null` `ageMs` returns `{ severity: 'info', isTransitionEdge: false, ... }` (fail-safe per FR-006/FR-007 monitor side).
  - `emitDropLog(logger, decision, payload, message)` — thin adapter that dispatches to `logger.info` or `logger.warn`.
  - One-liner JSDoc on `classifyDropSeverity` naming the transition-edge invariant ("one severity flip in, one severity flip out") and pointing at `pr-feedback-monitor-service.ts:284-286` as the mirrored pattern.

- [X] T004 [US3] Create `packages/orchestrator/src/services/__tests__/drop-log-helper.test.ts` — pure-function tests covering:
  - Below threshold → `info`, no transition edge.
  - Crossing threshold upward → `warn` with `isTransitionEdge: true`.
  - Second call at same threshold state → `warn`, `isTransitionEdge: false` (stays but does not re-emit as edge).
  - Wait, per FR-006 the between-transitions cycles must NOT emit repeated `warn`s — assert `severity` stays `warn` between edges but caller uses `isTransitionEdge` to decide whether to emit at all. Assert the state Map carries `lastSeverity: 'warn'` after the first edge.
  - Falling back below threshold → transition-edge `info`.
  - `null` `ageMs` → `info` fail-safe, no state mutation.
  - Two different itemKeys have independent state (no cross-contamination via shared Map).
  - Threshold boundary: `ageMs === thresholdMs` is not yet `warn` (strict `>` per contract), `ageMs === thresholdMs + 1` is.
  - `it()` names prefixed with FR-006/FR-007/SC-003 markers matching the existing convention.

## Phase 3: RedisQueueAdapter reclaim path

- [X] T005 [US1] [US2] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, add the module-level `RECLAIM_ORPHAN_SCRIPT` Lua string per the "Final contract" in `contracts/reclaim-orphan-script.md` (5 ARGV: `itemKey`, `ageMs`, `graceWindowMs`, `resumePriority`, `reclaimItemJSON`; return codes `0` no-op / `1` reclaimed / `2` heartbeat re-appeared / `3` within grace). Add private `ensureReclaimOrphanCommand()` that calls `this.redis.defineCommand('reclaimOrphan', { numberOfKeys: 4, lua: RECLAIM_ORPHAN_SCRIPT })` following the existing pattern at the neighbouring scripts. JSDoc mirroring existing script docstrings at `:13-30` / `:32-40`.

- [X] T006 [US1] [US2] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, add public `async reapOrphanClaims(now = Date.now()): Promise<ReapReport>`:
  - `SCAN` `orchestrator:queue:claimed:*` with `COUNT 100`; for each key `HGETALL` to enumerate `itemKey → payload` pairs.
  - Per (workerId, itemKey, payload): parse JSON; compute `ageMs = now - Date.parse(payload.enqueuedAt)`; build the reclaim item (`attemptCount + 1`, `queueReason: 'resume'`, `priority: getPriorityScore('resume')`, preserved `enqueuedAt` + `metadata`) — per FR-002 / clarifications Q3=C.
  - Invoke registered `reclaimOrphan` Lua with `[claimedKey, heartbeatKey, IN_FLIGHT_KEY, PENDING_KEY]` + `[itemKey, String(ageMs), String(graceWindowMs), String(getPriorityScore('resume')), reclaimItemJSON]`.
  - Interpret return code into the `ReapReport`. On code `1`, emit FR-008 `warn` log line: `{ workerId, itemKey, ageMs, attemptCountBefore, attemptCountAfter, reason: 'orphaned-claim-no-heartbeat' }` (once per reclaim event; NOT transition-edge gated).
  - On any Redis error mid-sweep: `warn` and return the partial `ReapReport` so subsequent cycles retry.
  - Grace window derivation: use `2 × this.config.heartbeatCheckIntervalMs` (FR-005 default).

- [X] T007 [US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, add public `async hasInFlightAge(itemKey: string): Promise<number | null>` — `SCAN` `CLAIMED_KEY_PREFIX*`, for each key `HGET` the itemKey field; on match parse `enqueuedAt` and return `Date.now() - Date.parse(...)`. Return `null` on transport error or if the itemKey is not in flight (per AD-11). Complexity note in JSDoc: O(N-workers); acceptable because drop path is not hot (fires only on collision) and N is small.

- [X] T008 [US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, modify `enqueueIfAbsent` drop-log at `:141-144`:
  - Add a private instance field `private readonly dropLogState = new Map<string, DropTransitionState>()`.
  - When the SISMEMBER gate returns 1, before logging, call `hasInFlightAge(itemKey)` (already inside the adapter — can reuse the HGETALL-based path) to derive `ageMs`.
  - Dispatch through `classifyDropSeverity(itemKey, ageMs, this.config.maxRunDurationMs, this.dropLogState)` then `emitDropLog(logger, decision, { itemKey, reason: 'in-flight', ageMs }, 'Dropping enqueue (item already in flight)')`.
  - Preserve the existing structured fields (`itemKey`, `reason: 'in-flight'`) verbatim so downstream log queries and alerts key on unchanged shape (only severity flips on transition edge).

- [X] T009 [US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, in `complete()` (~`:306`) and any `release()` success branches that clear the itemKey from in-flight, add `this.dropLogState.delete(itemKey)` to bound the transition-edge Map growth (R6). Single-line change per site; O(1) Map delete.

## Phase 4: InMemoryQueueAdapter parity

- [X] T010 [P] [US1] [US3] In `packages/orchestrator/src/services/in-memory-queue-adapter.ts`:
  - Add `async reapOrphanClaims(now?: number): Promise<ReapReport>` returning `{ scanned: 0, reclaimed: [], skippedRaceReappeared: 0, skippedGraceWindow: 0 }` (no-op per FR-011 / clarifications Q5=C — in-memory process death is total, no orphans can survive).
  - Add `async hasInFlightAge(itemKey: string): Promise<number | null>` reading the in-memory claim map's `enqueuedAt` field and returning `now - Date.parse(...)` (or `null` if not in flight).
  - Modify `enqueueIfAbsent` drop-log at `:89` to route through the same `classifyDropSeverity`/`emitDropLog` helper with its own private `dropLogState: Map<string, DropTransitionState>`. Structured fields identical to the Redis adapter — `{ itemKey, reason: 'in-flight', ageMs }`.
  - Add matching `delete(itemKey)` from `dropLogState` on `complete()` and successful `release()`.

## Phase 5: Dispatcher wire-up

- [X] T011 [US1] In `packages/orchestrator/src/services/worker-dispatcher.ts`, extend `reaperLoop` at `:564-576`:
  - After the existing `await this.reapStaleWorkers()` call, add sequential `const report = await this.queue.reapOrphanClaims().catch(err => { this.logger.warn({ err }, 'reapOrphanClaims failed'); return null; })` (per AD-4 — sequential, not parallel; per R2/R3 error tolerance — a Redis error must not skip subsequent cycles).
  - When `report && (report.reclaimed.length > 0 || report.skippedRaceReappeared > 0 || report.skippedGraceWindow > 0)`, emit a single machine-parseable `info` log line: `{ scanned, reclaimed: reclaimed.length, skippedRaceReappeared, skippedGraceWindow }` mirroring the shape of the neighbouring reaper warn at `:583-586`.
  - Zero change to `reapStaleWorkers` itself (FR-010).

## Phase 6: Monitor drop-site escalation

- [X] T012 [P] [US3] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`, modify the drop log at `:428`:
  - Add `private readonly monitorDropState = new Map<string, DropTransitionState>()` on the service class.
  - Replace the `logger.info(...)` call with `const ageMs = await this.queueManager.hasInFlightAge(itemKey); const decision = classifyDropSeverity(itemKey, ageMs, this.config.maxRunDurationMs, this.monitorDropState); emitDropLog(logger, decision, { itemKey, reason: 'in-flight', prNumber, ageMs }, 'Dropping PR-feedback enqueue (item already in flight)');`
  - Preserve all existing structured fields (`prNumber` etc.) verbatim (FR-007 two-log-lines-per-drop pattern; only severity flips).
  - On `null` `ageMs`, helper returns `info` (fail-safe per AD-11).

- [X] T013 [P] [US3] In `packages/orchestrator/src/services/merge-conflict-monitor-service.ts`, modify the drop log at `:186` with identical shape to T012, message text `'Dropping merge-conflict enqueue (item already in flight)'`, own `monitorDropState` Map on the class, preserve merge-conflict-specific structured fields.

- [X] T014 [P] [US3] In `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`, modify the drop log at `:240` with identical shape, message text `'Dropping clarification-answer enqueue (item already in flight)'`, own `monitorDropState` Map, preserve clarification-specific structured fields.

- [X] T015 [P] [US3] In `packages/orchestrator/src/services/label-monitor-service.ts`, modify the drop log at `:361` with identical shape, message text `'Dropping resume event (item already in flight)'`, own `monitorDropState` Map, preserve `phase`/`gate`/etc. structured fields.

## Phase 7: Verification tests

- [X] T016 [US4] Create `packages/orchestrator/src/services/__tests__/redis-queue-adapter.orphan-reclaim.test.ts` — FR-009 regression suite reproducing the exact wedge from `generacy-ai/generacy#1051`. Reuse the existing hand-rolled stateful mock pattern from `redis-queue-adapter.enqueueIfAbsent.test.ts:16-125`, extended with `EXISTS`/`SCAN`/`HGET`/`HGETALL`/`HDEL`/`HLEN`/`DEL`/`SREM`/`ZADD` behaviour and the `defineCommand('reclaimOrphan', ...)` Lua stub (JS-side simulation of the return-code contract in `contracts/reclaim-orphan-script.md`). Cases (all `it()` names prefixed per convention):
  - `FR-001 / SC-001 / US4`: enqueue → claim under synthetic workerId → delete heartbeat key directly → run `reapOrphanClaims` once → assert (a) claim hash `HGET` returns nil / claim key `EXISTS` returns 0, (b) itemKey no longer in `orchestrator:queue:in-flight-items`, (c) item present in `orchestrator:queue:pending` with `queueReason: 'resume'` + `priority: 0` + `attemptCount: 1` + preserved `enqueuedAt` and `metadata`, (d) subsequent `enqueueIfAbsent` for the same itemKey succeeds.
  - `US2 / SC-002` negative: claim with live heartbeat (any TTL > 0) → run reap → assert claim hash unchanged, itemKey still in in-flight SET, no ZADD to pending, no FR-008 warn emitted.
  - `FR-005 / US2`: claim with heartbeat absent but `enqueuedAt` within `2 × heartbeatCheckIntervalMs` of `now` → assert `skippedGraceWindow` incremented, no mutation.
  - `US2 race abort`: outer-loop `EXISTS` returned 0 but Lua-stub simulates return code `2` (heartbeat re-appeared server-side) → assert `skippedRaceReappeared` incremented, no mutation, no FR-008 warn.
  - `AD-6 / FR-002`: reclaimed item's `attemptCount` is source `+ 1` (not preserved, not gated on maxRetries — reaper never dead-letters).
  - `AD-9`: reclaimed item's `queueReason` is `'resume'` and `priority` is `getPriorityScore('resume')`.
  - `FR-008`: reclaim emits a single `warn` line with `{ workerId, itemKey, ageMs, attemptCountBefore, attemptCountAfter, reason: 'orphaned-claim-no-heartbeat' }`; assert `attemptCountBefore` and `attemptCountAfter` are both present so infra-caused increments stay distinguishable from execution-failure increments in log queries.

- [X] T017 [US3] Modify `packages/orchestrator/src/services/__tests__/redis-queue-adapter.enqueueIfAbsent.test.ts` — add two cases:
  - `FR-006 / SC-003`: after an itemKey has been in flight past `maxRunDurationMs`, a fresh `enqueueIfAbsent` for the same itemKey emits `warn` (not `info`) with `{ itemKey, reason: 'in-flight', ageMs }` and `ageMs > maxRunDurationMs`.
  - `FR-006 transition-edge`: after the initial `warn`, subsequent `enqueueIfAbsent` calls for the same itemKey (age still > threshold) do NOT re-emit `warn` — they stay silent at `info` until the itemKey clears (via `complete()` clearing the `dropLogState` Map — T009).
  - Keep existing test cases untouched.

## Phase 8: Changeset

- [X] T018 [US1] Create `.changeset/1054-orphan-claim-reclaim.md` with a `patch` bump for `@generacy-ai/orchestrator`, marked `workflow:speckit-bugfix`. Body: one-sentence summary linking #1054 ("Reclaim orphaned queue claims when the owning worker dies without unwinding; escalate wedged-in-flight drop logs to `warn` on the transition edge."). Per CLAUDE.md — the new `QueueManager.reapOrphanClaims`/`hasInFlightAge` methods are not re-exported from the package's public `index.ts`, so `patch` is correct.

## Dependencies & Execution Order

**Sequential dependencies**:

1. **Phase 1 first** — T001 and T002 (schema + types) unblock everything downstream because every subsequent task imports the new types (`ReapReport`, `DropTransitionState`) or reads `config.maxRunDurationMs`.
2. **Phase 2 before Phases 3–6** — T003 (`drop-log-helper.ts`) is imported by both adapters and all four monitor sites. T004 tests are independent and can run in parallel with T005+.
3. **Phase 3 (Redis adapter) before Phase 5 (dispatcher wire-up)** — T011 calls `queue.reapOrphanClaims()`. Within Phase 3: T005 → T006 (T006 invokes the script registered by T005); T007 depends on the outer HGETALL pattern established in T006; T008 uses T007's `hasInFlightAge` and the helper from T003; T009 is a small addition co-located with T008.
4. **Phase 3 before Phase 4** — T010 mirrors T005/T007/T008 behaviourally (no-op reap + real `hasInFlightAge` + shared-helper dispatch) so best to land the Redis version first as the source of truth.
5. **Phase 6 after Phase 3+4** — T012–T015 call `queueManager.hasInFlightAge(...)`, which is defined in T007 and T010.
6. **Phase 7 after Phases 3–6** — T016 tests the Redis reclaim path (needs Phase 3); T017 tests the drop-log escalation (needs T008).
7. **Phase 8 last** — the changeset must be added as part of the PR and CI checks its presence; land it once all source changes are in.

**Parallel opportunities within phases**:

- **Phase 1**: T001 and T002 touch different files → both `[P]`.
- **Phase 4**: T010 is `[P]` with the closing tasks of Phase 3 (T008/T009) since it touches only `in-memory-queue-adapter.ts` — but must wait for T003 (helper) and T002 (types).
- **Phase 6**: T012, T013, T014, T015 each touch a distinct monitor file → all `[P]` with each other. All depend on T007+T010 being complete (for `hasInFlightAge`) and T003 (for the helper).
- **Phase 7**: T016 and T017 touch different test files → both `[P]`.

**Critical path** (longest sequential chain): T002 → T003 → T005 → T006 → T007 → T008 → T011 → T016 → T018.

## Playbook coupling

No `packages/claude-plugin-cockpit/commands/*.md` files appear in spec.md or plan.md — no `playbook-verification.test.ts` re-pin task is required.
