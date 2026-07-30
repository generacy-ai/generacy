# Tasks: RedisQueueAdapter.enqueue() must maintain the in-flight-SET invariant

**Input**: Design documents from `/specs/1060-problem-redisqueueadapter/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Interface + adapter contract (FR-001, FR-006 — foundation)

<!-- All Phase 1 tasks touch shared files; sequential ordering. Callers (Phase 2) and tests (Phase 3) depend on the boolean return being live before they compile / run. -->

- [X] T001 [US1][US3] Update `QueueAdapter.enqueue` signature in `packages/orchestrator/src/types/monitor.ts` (~line 229–231): change return type from `Promise<void>` to `Promise<boolean>`. Add JSDoc block on the interface method documenting the invariant `after enqueue(item) returns true, item.itemKey MUST be a member of the in-flight index` and the end-to-end invariant `in-flight = pending ∪ claimed` across `enqueue → claim → release-retry → reclaim-orphan → complete`. `QueueManager.enqueue` inherits automatically (no local override at ~line 284). Reference: `contracts/queue-adapter-interface.md` § "Signature change", `data-model.md` § "Interface change: `QueueAdapter.enqueue`".

- [X] T002 [US1] Add `ENQUEUE_SCRIPT` string constant to `packages/orchestrator/src/services/redis-queue-adapter.ts` next to the four existing script constants (`ENQUEUE_IF_ABSENT_SCRIPT`, `CLAIM_SCRIPT`, `RELEASE_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`). Use the D6-b Lua body from `data-model.md` § "Lua body (D6-b — recommended)" (byte-identical to `ENQUEUE_IF_ABSENT_SCRIPT`): `SISMEMBER KEYS[2] ARGV[1]` → early-exit `return 0` if 1 → else `SADD KEYS[2] ARGV[1]` + `ZADD KEYS[1] tonumber(ARGV[2]) ARGV[3]` + `return 1`. Do NOT include the `HSET _dedup:*` write (D6-a) unless PR reviewer explicitly requests strict FR-001 compliance — see `research.md § Decision 6`. Add `ensureEnqueueCommand()` guard following the sibling `ensureEnqueueIfAbsentCommand()` pattern at ~line 209–216. `numberOfKeys: 3` (pending ZSET, in-flight SET, `_dedup:<itemKey>` hash — even though D6-b never writes KEYS[3], keep the key slot for future D6-a upgrade). Reference: `contracts/enqueue-script.md` § "Keys", "Args", "Return codes".

- [X] T003 [US1] Rewrite `RedisQueueAdapter.enqueue()` at `packages/orchestrator/src/services/redis-queue-adapter.ts:579-601` to invoke the new `enqueueItem` command via `defineCommand`. Serialize the `QueueItem` to `SerializedQueueItem` JSON (existing helper), pass ARGV[1]=`itemKey`, ARGV[2]=`String(getPriorityScore(item.queueReason))`, ARGV[3]=`JSON.stringify(serialized)`. On `result === 1`: seed `enqueuedAtCache.set(itemKey, Date.parse(item.enqueuedAt))`, log at `info` `'Item enqueued to Redis sorted set (in-flight-checked)'`, `return true`. On `result === 0`: call `hasInFlightAge(itemKey)` for `ageMs`, call `classifyDropSeverity(itemKey, ageMs, maxRunDurationMs, dropLogState)`, call `emitDropLog(logger, decision, { itemKey, source: 'enqueue', reason: 'in-flight', ageMs }, 'Dropping enqueue (item already in flight)')`, `return false`. Reference: `contracts/enqueue-script.md` § "Postconditions", `data-model.md` § "Log line schema".

- [X] T004 [US1][US3] Update `InMemoryQueueAdapter.enqueue()` at `packages/orchestrator/src/services/in-memory-queue-adapter.ts:64-102`. Change return type from `Promise<void>` to `Promise<boolean>`. Preserve the existing dedupe-against-`pendingQueue`+`claimedItems`+add-to-`inFlightSet` behaviour. Convert the two existing `logger.debug` dedupe log lines into a single `emitDropLog` call with fields `{ itemKey, source: 'enqueue', reason: 'in-flight', ageMs }` (compute `ageMs` via the existing `hasInFlightAge` public method) so the log-line shape matches Redis (SC-003). Return `true` on successful enqueue, `false` on dedupe drop. Reference: `data-model.md` § "Log line schema", `research.md § Decision 4`.

## Phase 2: Caller updates (FR-003)

<!-- Phase boundary: Phase 1 must complete first — Phase 2 callers observe the new boolean return. -->

- [X] T005 [P] [US1] Update `LabelMonitorService.processLabelEvent()` `type === 'process'` branch at `packages/orchestrator/src/services/label-monitor-service.ts:~428` (the call site for `queueManager.enqueue(...)`). Observe the boolean return; on `false` treat as success and continue with existing post-enqueue steps (label management, `phaseTracker.markProcessed`). Do NOT emit any additional log line — the adapter owns FR-005 via `emitDropLog`. Do NOT branch to error/retry; the item is already in-flight and the enqueue's intent is satisfied. Reference: `contracts/queue-adapter-interface.md` § "LabelMonitorService.processLabelEvent()", `research.md § Decision 4`.

- [X] T006 [P] [US1] Update `WorkerDispatcher.handleLeaseExpired()` at `packages/orchestrator/src/services/worker-dispatcher.ts:245-278` (specifically the re-enqueue path around `:267-273`). Call `queue.release(workerId, worker.item)` **before** the `queue.enqueue(...)` call. Recommended: remove the now-redundant `queue.enqueue(...)` call entirely (release's retry branch already re-pends via `HDEL claimed` / `DEL heartbeat` / `ZADD pending` while preserving in-flight-SET membership). If keeping the call, annotate with a `// FR-003 — expected to drop; release() already re-pended` comment so a future reader does not misread the drop as a bug. Note the priority-tier divergence per `research.md § Decision 3` Option R1 (recommended): lease-expired items now land at `retry` priority instead of `resume` — acceptable divergence, matches how the queue treats any retry. Do NOT modify `release()`'s signature (R2 is a follow-up if ops feedback justifies). Reference: `contracts/queue-adapter-interface.md` § "WorkerDispatcher.handleLeaseExpired()", `research.md § Decision 3`.

## Phase 3: Regression coverage (FR-007, FR-008 — parallelizable across three new test files)

<!-- Phase boundary: Phases 1 + 2 must be functionally complete — tests validate the new behaviour end-to-end. -->

- [X] T007 [P] [US4] Create `packages/orchestrator/src/services/__tests__/redis-queue-adapter.enqueue-invariant.test.ts` targeting real Redis (follow the `redis-queue-adapter.orphan-reclaim.test.ts` harness pattern — NOT the mocked pattern from `redis-queue-adapter.enqueueIfAbsent.test.ts`). Assertions: (a) `enqueue({ itemKey: k })` → `SISMEMBER IN_FLIGHT_KEY k === 1` (SC-002); (b) `enqueue → enqueue` same key → second call returns `false`, `ZCARD PENDING_KEY === 1`, `SCARD IN_FLIGHT_KEY === 1` (no double-add); (c) `enqueue → claim` → `SISMEMBER IN_FLIGHT_KEY k === 1` (CLAIM_SCRIPT preserves); (d) `enqueue → claim → release-retry → reclaim-orphan → complete` sequence with invariant assertion `in-flight-items == pending-keys ∪ claimed-keys` at every intermediate step (SC-004); (e) Named regression test in its own `describe('#1060 observed incident regression', ...)` block — reproduces FR-008 wedge: `enqueue(#N)` → `claim(worker-A, #N)` → concurrent `enqueueIfAbsent(#N)` from a monitor code path → assert second call dropped, `ZCARD pending === 0`, exactly one claim exists. Reference: `contracts/enqueue-script.md` § "Test hooks", `plan.md § Phase 3`, `quickstart.md § Manual invariant check` (adapt the Lua one-shot to a vitest assertion helper).

- [X] T008 [P] [US4][US3] Create `packages/orchestrator/src/services/__tests__/in-memory-queue-adapter.enqueue-invariant.test.ts`. Run the same FR-007 sequence as T007 against `InMemoryQueueAdapter` directly (no Redis infrastructure). Inspect `inFlightSet` membership via the public `hasInFlight` method. Assertions mirror T007 (a)-(d); the T007 (e) wedge test does not apply to in-memory (no cross-adapter concurrent-monitor mechanism to reproduce). Reference: `plan.md § Phase 3` step 9.

- [X] T009 [P] [US3][US4] Create `packages/orchestrator/src/services/__tests__/queue-adapter-parity.test.ts`. Parameterized `describe.each([['redis', redisFactory], ['in-memory', inMemoryFactory]])`. Assertions: identical drop-vs-accept decision on the FR-007 sequence, identical log-line shape (`{ itemKey, source: 'enqueue', reason: 'in-flight', ageMs }` — capture via logger spy on both adapters), identical `enqueue → claim → release-retry → complete` outcomes. Redis factory reuses the `redis-queue-adapter.orphan-reclaim.test.ts` connection harness; in-memory factory instantiates fresh per test. Satisfies SC-003 (cross-adapter parity) in one file. Reference: `research.md § Decision 7`, `plan.md § Phase 3` step 10.

## Phase 4: Regression-guard verification + changeset

<!-- Phase boundary: All tests must be passing before verifying SC-006 and authoring the changeset. -->

- [X] T010 [US4] Verify SC-006 (regression guard fires): temporarily delete the `SADD KEYS[2] ARGV[1]` line from the `ENQUEUE_SCRIPT` constant added in T002; re-run the T007 + T008 + T009 suite; assert that at least one test fails with a clear "in-flight-SET not populated" style failure. Restore the line. Document the demonstration in the PR description (short paragraph naming which test caught it). This is a one-shot verification, not a committed test change. Reference: `contracts/enqueue-script.md` § "Test hooks", `plan.md § Phase 3` step 8 last bullet.

- [X] T011 [US1] Verify SC-005 (no additional Redis round-trip on healthy dispatch path): run `redis-cli MONITOR` in one terminal while triggering a `process:speckit-feature` label transition that flows `enqueue → claim → complete` in another. Confirm the fix adds exactly one Redis operation inside the atomic Lua body (the `SADD KEYS[2] ARGV[1]` inside `ENQUEUE_SCRIPT`), not a separate round-trip. Compare command count against `main`. Document in PR description. Reference: `spec.md § SC-005`.

- [X] T012 [US1] Author `.changeset/1060-redis-enqueue-invariant.md` per CLAUDE.md changeset gate. Run `pnpm why @generacy-ai/orchestrator` to confirm no external sibling package declares `@generacy-ai/orchestrator` in `dependencies` (only in-monorepo). Default bump: `@generacy-ai/orchestrator: patch` (internal-only public API change — both callers of `enqueue()` are in-package). Upgrade to `minor` if any sibling package in the monorepo declares it in `dependencies` AND calls `enqueue()` expecting `Promise<void>`. Message: one-line description of the invariant restoration + reference to `#1060`. Reference: `research.md § Decision 8`, `plan.md § Phase 4`.

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- **Phase 1** (T001–T004) → **Phase 2** (T005–T006) → **Phase 3** (T007–T009) → **Phase 4** (T010–T012)
- Phase 1 must land before Phase 2 (callers depend on the new boolean return type compiling).
- Phase 2 must land before Phase 3 (regression tests exercise the caller-side sequencing change in T007's wedge scenario).
- Phase 3 must land before Phase 4 (SC-006 verification in T010 requires the new test suite to exist).

**Within-phase ordering**:
- **Phase 1**: T001 (interface) → T002 (Lua constant) → T003 (Redis adapter using new command) → T004 (in-memory parity). T003 and T004 both depend on T001; T003 also depends on T002. T004 can start once T001 lands.
- **Phase 2**: T005 and T006 are `[P]` — different files, no shared state, both depend only on Phase 1 completion.
- **Phase 3**: T007, T008, T009 are `[P]` — three new independent test files. Ordering within Phase 3 is irrelevant.
- **Phase 4**: T010 depends on T007+T008+T009 landing (test suite must exist). T011 is a runtime verification independent of T010. T012 (changeset) can land anytime in Phase 4 but should be the final commit before opening the PR.

**Parallel opportunities**:
- T005 || T006 (Phase 2)
- T007 || T008 || T009 (Phase 3)
- T010 || T011 (Phase 4 — both are verification, no shared file)
