# Tasks: Periodic in-flight/claim reconciliation to close #1054 finding 6 residue

**Input**: Design documents from `/specs/1058-follow-up-1054-pr/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/queue-manager-additions.md, contracts/reconcile-in-flight-script.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Interface widening (types contract)

- [X] T001 [US1][US2][US3][US4] Add `ReconcileReport` exported interface and widen `QueueManager` with
  `reconcileInFlight(now?: number): Promise<ReconcileReport>` in
  `packages/orchestrator/src/types/monitor.ts` (co-locate method with `reapOrphanClaims` around `:398`;
  place `ReconcileReport` after `ReapReport` around `:435-444`). Follow the JSDoc shapes verbatim from
  `specs/1058-follow-up-1054-pr/contracts/queue-manager-additions.md` — reference FR-001 (two-sweep gate),
  Q1=D, Q2=B, Q3=C, Q4=B, AD-5, AD-6.

---

## Phase 2: Redis adapter — script, tracker fields, method

<!-- Depends on Phase 1 (interface must exist before implementation). Tasks T002 and T003 both
     touch `redis-queue-adapter.ts`, so they run sequentially. -->

- [X] T002 [US1][US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, add module-level
  constants BEFORE the class body:
  - `RECONCILE_IN_FLIGHT_SCRIPT` — the Lua body from `contracts/reconcile-in-flight-script.md § Wire shape`
    (SISMEMBER→early-return-0 else SREM→return 1), with JSDoc mirroring the shape at `:41-52` / `:86-99`.
  - `RECONCILE_LOG_CAP = 100` (per FR-004 / Q4=B).
  - `export const _RECONCILE_IN_FLIGHT_SCRIPT_FOR_TESTS = RECONCILE_IN_FLIGHT_SCRIPT` with `@internal`
    JSDoc for the script-wiring static-assertion test.

- [X] T003 [US1][US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, add three private
  fields on `RedisQueueAdapter` (near existing `dropLogState` at `:328` / `enqueuedAtCache` at `:338`):
  - `private readonly reconcileTracker = new Map<string, number>()` — itemKey → firstSeenSweepId (JSDoc
    per data-model.md § `RedisQueueAdapter` new private fields).
  - `private reconcileSweepCounter = 0` — monotonic per-instance sweep counter.
  - `private reconcileInFlightCommandDefined = false` — Lua command-registration guard.
  Add private `ensureReconcileInFlightCommand()` following the existing `ensureXCommand()` pattern
  (mirror `ensureReclaimOrphanCommand()` at `:373-380`): registers `defineCommand('reconcileInFlightItem',
  { numberOfKeys: 1, lua: RECONCILE_IN_FLIGHT_SCRIPT })`. Command name uses `Item` suffix so it does not
  shadow the class method name (same convention as `ensureRequeueForResumeCommand`).

- [X] T004 [US1][US2][US3] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, implement
  `public async reconcileInFlight(now = Date.now()): Promise<ReconcileReport>`. Follow the shape from
  `contracts/queue-manager-additions.md § RedisQueueAdapter.reconcileInFlight` and
  `contracts/reconcile-in-flight-script.md § Client-side pre-computation`:
  1. Increment `this.reconcileSweepCounter`; local `sweepId` = incremented value.
  2. `ensureReconcileInFlightCommand()`.
  3. Snapshot phase (all under one `try` for FR-004 error-tolerance):
     - `SSCAN IN_FLIGHT_KEY` batches with `COUNT 100` → `inFlightSet: Set<string>`.
     - `ZRANGE PENDING_KEY 0 -1` → `JSON.parse` each member → `pendingSet: Set<string>` (skip malformed
       members silently — separate correctness concern per spec Out of Scope).
     - `SCAN CLAIMED_KEY_PREFIX*` with `COUNT 100` + `HKEYS` per hash → `claimedSet: Set<string>`.
  4. Compute `residue = inFlightSet \ (pendingSet ∪ claimedSet)` client-side.
  5. Two-sweep gate:
     - For each `itemKey` in `residue`:
       - Not in tracker → `reconcileTracker.set(itemKey, sweepId)`, `logger.debug({ event:
         'orphan-in-flight-tracked', itemKey, firstSeenSweepId: sweepId })`, `report.trackedFirstSeen++`.
       - Tracker has `firstSeenSweepId < sweepId` → `(this.redis as any).reconcileInFlightItem(
         IN_FLIGHT_KEY, itemKey)`:
         - `1` (reconciled): compute `ageMs` from `enqueuedAtCache.get(itemKey)` (null on miss —
           mirrors `reapOrphanClaims` at `:646-654`); delete tracker entry; `enqueuedAtCache.delete(itemKey)`
           AND `dropLogState.delete(itemKey)` (AD-6 / Q3=C); `report.reconciled++`; emit warn subject to
           `RECONCILE_LOG_CAP` (see T005).
         - `0` (skipped-race-reappeared): `report.skippedRaceReappeared++`; retain tracker entry.
         - throw: `logger.warn({ err, event: 'orphan-in-flight-lua-error', itemKey })`, continue.
     - For each `itemKey` in `reconcileTracker` NOT in `residue`: delete tracker entry (transient race
       self-clear).
  6. Emit aggregate log if `RECONCILE_LOG_CAP` was exceeded (see T005).
  7. Transport error in snapshot phase: `logger.warn({ err, event: 'reconcile-in-flight-snapshot-error' })`
     and return the partial `report` so subsequent cycles retry.
  8. Never throw. Return the `ReconcileReport`.

- [X] T005 [US2] In the same `reconcileInFlight` method body, implement FR-004 log-cap accounting:
  - Track `emittedCount` and a `suppressed: string[]` list per cycle.
  - For each successful `SREM`, if `emittedCount < RECONCILE_LOG_CAP`: emit `logger.warn({ event:
    'orphan-in-flight-reconciled', itemKey, ageMs, reason: 'in-flight-no-pending-no-claim' })` and
    increment `emittedCount`. Else: push `itemKey` to `suppressed`.
  - After the sweep loop finishes, if `suppressed.length > 0`: emit exactly one `logger.warn({ event:
    'orphan-in-flight-reconciled-batch', count: suppressed.length, sampledItemKeys: suppressed.slice(0, 10) })`.
  - Cycle summary line is emitted by the DISPATCHER, not by the adapter (see T009) — per data-model.md
    the summary lives at the reaperLoop callsite alongside `reap-orphan-claims`.

- [X] T006 [US1] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, update the
  `#1054 finding 6 — KNOWN RESIDUE` docstring on `reapOrphanClaims` at `:566-571` per FR-007: state that
  the residue is now closed by `reconcileInFlight` and cross-reference the new method. Preserve historical
  context — future readers may want to know why the two-directional sweep exists rather than a single
  unified sweep.

---

## Phase 3: In-memory adapter — no-op parity

<!-- Depends on Phase 1 (interface). Independent of Phase 2 — can run in parallel with T002-T006. -->

- [X] T007 [P] [US4] In `packages/orchestrator/src/services/in-memory-queue-adapter.ts`, add
  `public async reconcileInFlight(_now?: number): Promise<ReconcileReport>` returning
  `{ scanned: this.inFlightSet.size, reconciled: 0, skippedRaceReappeared: 0, trackedFirstSeen: 0 }`.
  Add one-line JSDoc per contracts/queue-manager-additions.md § InMemoryQueueAdapter — explains that
  in-memory `pending`/`claimed`/`inFlightSet` are first-class fields in the same process that cannot
  diverge without a bug in this class (caught by `in-memory-queue-adapter.enqueue-invariant.test.ts` and
  siblings). Returning `scanned: this.inFlightSet.size` (not 0) gives call sites a truthful "sweep did
  examine the set" signal.

---

## Phase 4: Dispatcher wiring — reaperLoop + boot sweep

<!-- Depends on Phase 2 (RedisQueueAdapter.reconcileInFlight must exist) AND Phase 3 (InMemory must
     exist so both adapter shapes satisfy the QueueManager interface the dispatcher depends on). -->

- [X] T008 [US4] In `packages/orchestrator/src/services/worker-dispatcher.ts`, add the boot sweep per
  AD-4 / Q2=B. In `WorkerDispatcher.start()` at `:100-120`, BEFORE spawning `reaperLoop(ac.signal)` at
  `:111`, fire fire-and-forget: `void this.queue.reconcileInFlight().catch((err) => this.logger.warn(
  { err }, 'boot reconcileInFlight failed'))`. `start()` returns immediately; the loop's first regular
  sweep runs its own tracker check regardless.

- [X] T009 [US2][US4] In `packages/orchestrator/src/services/worker-dispatcher.ts::reaperLoop` at
  `:569-615`, wire `reconcileInFlight` sequentially AFTER `reapOrphanClaims` (AD-5). Follow the
  `worker-dispatcher.ts:588-593` pattern for the `.catch(...)` error envelope. Add the per-cycle summary
  log at the same site as `reap-orphan-claims` at `:600-609`:
  `logger.info({ event: 'reconcile-in-flight', scanned, reconciled, skippedRaceReappeared, trackedFirstSeen })`,
  gated on `reconciled > 0 || skippedRaceReappeared > 0 || trackedFirstSeen > 0` so a fully healthy
  cycle produces zero log lines (matches `reapOrphanClaims`'s conditional summary at `:594-599`).

---

## Phase 5: Tests — FR-008 regression coverage

<!-- Depends on Phases 1-4 (all implementation must exist). T010, T011, T012, T013 touch four
     independent test files → all four can run in parallel. -->

- [X] T010 [P] [US1][US2][US3][US5] NEW file
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.reconcile-in-flight.integration.test.ts`.
  Real-Redis integration suite mirroring `redis-queue-adapter.reclaim-lua.test.ts` and
  `redis-queue-adapter.orphan-reclaim.test.ts` patterns. Cases covering FR-008 (a-h):
  - (a) SC-001 wedge-state repair, two-sweep gated: direct `SADD IN_FLIGHT_KEY test-item` without
    pending/claim → cycle 1 arms tracker + emits `debug` `orphan-in-flight-tracked` + zero `SREM` →
    cycle 2 fires atomic `SREM` + emits `warn` `orphan-in-flight-reconciled` → assert
    `SISMEMBER IN_FLIGHT_KEY test-item == 0` AND subsequent `enqueueIfAbsent(test-item)` succeeds
    (returns 1, adds to pending, adds back to IN_FLIGHT_KEY).
  - (b) SC-002 healthy-state no-op: run full `enqueue → claim → complete` cycle, invoke
    `reconcileInFlight` at each stage → assert zero `SREM IN_FLIGHT_KEY` calls, zero tracker entries
    persist past cycle 2.
  - (c) TOCTOU safety via two-sweep gate: schedule concurrent dispatch transition (pending→claimed)
    such that the client-side snapshot sees the item as residue transiently → cycle 1 arms tracker →
    by cycle 2 the item is in claimed → tracker drops without `SREM`, no `orphan-in-flight-reconciled`
    warn.
  - (d) SC-003 TOCTOU safety via Lua atomic re-check: after two-sweep confirmation, race a concurrent
    `enqueueIfAbsent(itemKey)` against the reconciliation Lua for the same itemKey (use fault injection
    or a targeted delay hook) → assert either the enqueue's `SADD` completed before the `SREM` (item
    legitimately live post-reconcile) OR reconciliation reported `skippedRaceReappeared++`. Never a
    state where the SET is empty while the item is pending.
  - (e) AD-6 cache cleanup: successful `SREM` → `enqueuedAtCache.get(itemKey)` returns undefined AND
    `dropLogState.get(itemKey)` returns undefined (assert via adapter-internal introspection or via
    subsequent `hasInFlightAge(itemKey)` returning null).
  - (f) FR-004 log-shape assertion: spy on logger → assert `orphan-in-flight-reconciled` warn has
    exactly `{ event, itemKey, ageMs, reason: 'in-flight-no-pending-no-claim' }` shape; `ageMs` is a
    number when cache hit, `null` when cache miss.
  - (g) SC-006 log-cap enforcement: produce >`RECONCILE_LOG_CAP` (=100) residue items → cycle 2 emits
    exactly 100 individual `orphan-in-flight-reconciled` warns + exactly one aggregate
    `orphan-in-flight-reconciled-batch` warn with `{ event, count, sampledItemKeys: [<first 10>] }`.
  - (h) Boot-sweep behavior: construct adapter, `SADD IN_FLIGHT_KEY pre-existing-residue`, invoke
    `reconcileInFlight` once (the boot sweep) → assert tracker contains the residue after boot; run
    one more sweep → residue is `SREM`'d.
  Test cases prefixed with FR-###/SC-### tags in `it()` names per convention in
  `redis-queue-adapter.orphan-reclaim.test.ts`.

- [X] T011 [P] [US4][US5] NEW file
  `packages/orchestrator/src/services/__tests__/in-memory-queue-adapter.reconcile-in-flight.test.ts`.
  Asserts the in-memory adapter's no-op contract: `reconcileInFlight` never `SREM`s anything, always
  returns `{ reconciled: 0, skippedRaceReappeared: 0, trackedFirstSeen: 0 }`, and `scanned` matches
  `inFlightSet.size` before and after a healthy `enqueue → claim → complete` cycle.

- [X] T012 [P] [US4][US5] MODIFIED
  `packages/orchestrator/src/services/__tests__/queue-adapter-parity.test.ts`. Add a parameterized
  `describe.each` block per `contracts/queue-manager-additions.md § Cross-adapter parity contract`:
  - `it('exists and returns a ReconcileReport shape', ...)` — asserts both adapters return
    `{ scanned, reconciled, skippedRaceReappeared, trackedFirstSeen }` all as numbers.
  - `it('healthy-state cycle produces zero reconciled', ...)` — runs `enqueueIfAbsent → claim →
    complete`, then `reconcileInFlight`, asserts `report.reconciled === 0` on both adapters.
  Wedge-repair (SC-001) is Redis-only per contract — do NOT add a wedge case here.

- [X] T013 [P] [US1][US5] MODIFIED
  `packages/orchestrator/src/services/__tests__/redis-queue-adapter.script-wiring.test.ts`. Add a
  `describe('RECONCILE_IN_FLIGHT_SCRIPT wire shape', ...)` block per
  `contracts/reconcile-in-flight-script.md § Script-wiring static assertion`:
  - `it('runs SISMEMBER then SREM in order ...', ...)` — imports `_RECONCILE_IN_FLIGHT_SCRIPT_FOR_TESTS`,
    asserts SISMEMBER precedes SREM in the script body.
  - `it('registers with numberOfKeys: 1 (CROSSSLOT-safe by construction)', ...)` — invokes
    `adapter.reconcileInFlight()` once to trigger `defineCommand`, asserts `(redis as any).
    reconcileInFlightItem` is defined via whatever introspection matches the existing test's style.

---

## Phase 6: Changeset (CI gate)

<!-- Depends on all implementation phases — changeset must be a NEW file added in this PR per CLAUDE.md
     `.github/workflows/changeset-bot.yml` gate. -->

- [X] T014 [US1][US2][US3][US4][US5] NEW file `.changeset/1058-reconcile-in-flight.md`. `patch` bump for
  `@generacy-ai/orchestrator` — internal contract between adapter and dispatcher; `QueueManager` is not
  re-exported from `packages/orchestrator/src/index.ts` per CLAUDE.md's "New exports that are not
  re-exported from the package's public `index.ts` are internal surface, not API — still `patch`."
  Verify at implement time with `pnpm why @generacy-ai/orchestrator`; upgrade to `minor` only if a
  monorepo sibling declares `@generacy-ai/orchestrator` in `dependencies` and touches `QueueManager`
  directly.
  Body: one-line summary matching the shape of existing changesets in `.changeset/` — reference #1058,
  the residue-in-SET repair, and complementarity with #1054/PR #1056 (`RECLAIM_ORPHAN_SCRIPT`) and
  #1060/PR #1065 (`ENQUEUE_SCRIPT` co-atomicity).

---

## Dependencies & Execution Order

**Sequential phase boundaries**:

- **Phase 1 → Phase 2, 3**: `ReconcileReport` type and `QueueManager.reconcileInFlight` interface entry
  must exist before either adapter can implement them.
- **Phase 2 + Phase 3 → Phase 4**: both adapters must implement `reconcileInFlight` (TypeScript will
  fail-compile the dispatcher call otherwise, since it types against `QueueManager`).
- **Phase 4 → Phase 5**: dispatcher wiring must exist before FR-008 tests can assert the boot sweep
  and per-cycle summary behavior (T010 case h, T009's summary log).
- **Phases 1-5 → Phase 6**: changeset added last (once diff shape is stable) so the file's bump level
  reflects the final surface area.

**Parallel opportunities**:

- **Within Phase 2**: T002, T003, T004, T005, T006 all touch `redis-queue-adapter.ts` → run sequentially.
  T004 depends on T002 (Lua constant) + T003 (private fields, `ensureReconcileInFlightCommand`).
  T005 is scoped inside T004's method body — no separate file, marked as a distinct task for review
  clarity but implemented in the same edit pass. T006 is a docstring-only change on `reapOrphanClaims`,
  independent of T002-T005, but shares the file — safe to bundle at the end of the Phase-2 edit pass.
- **Phase 2 and Phase 3 in parallel**: T007 (in-memory) is fully independent of T002-T006 (redis) —
  different files, no shared symbols beyond the T001 interface. Marked `[P]`.
- **Within Phase 5**: T010, T011, T012, T013 touch four independent test files → all four `[P]`,
  runnable concurrently once Phases 1-4 land.

**Critical path** (blocking sequence): T001 → T003 → T004 → T009 → T010(h boot-sweep case) → T014.

## Story coverage

| Story | Tasks |
|---|---|
| US1 (wedge self-repairing) | T001, T002, T003, T004, T006, T010(a,b,e), T013, T014 |
| US2 (observable) | T001, T004, T005, T009, T010(f,g), T014 |
| US3 (composes safely) | T001, T002, T003, T004, T010(c,d), T014 |
| US4 (bounded cadence) | T001, T007, T008, T009, T011, T012, T014 |
| US5 (regression coverage) | T010, T011, T012, T013 |

## Summary

- **Total tasks**: 14 (T001-T014)
- **Phase breakdown**: Phase 1 (1) / Phase 2 (5) / Phase 3 (1) / Phase 4 (2) / Phase 5 (4) / Phase 6 (1)
- **Parallelizable tasks**: T007 (Phase 3, parallel with Phase 2); T010, T011, T012, T013 (Phase 5,
  four-way parallel)
- **Files touched**: 4 source (`types/monitor.ts`, `services/redis-queue-adapter.ts`,
  `services/in-memory-queue-adapter.ts`, `services/worker-dispatcher.ts`) + 2 new test files
  + 2 modified test files + 1 changeset. Zero new source modules; zero new dependencies; zero new
  config knobs.
- **Mode**: Standard (fine-grained).
- **Next step**: `/speckit:implement` to begin execution.
