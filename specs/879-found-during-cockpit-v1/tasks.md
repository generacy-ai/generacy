# Tasks: PR-feedback enqueue migration to in-flight dedupe (#879)

**Input**: Design documents from `/specs/879-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/enqueue-dedupe.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1: stale-key survival, US2: race collapse; blank = shared/plumbing)

## Phase 1: Handler cleanup (FR-008)

- [X] T001 [US2] Delete `DEDUP_PHASE` constant (line 19), `clearDedupe` closure (lines 110-117), and all five terminal-path `clearDedupe()` call sites (lines ~259, ~289, ~370, ~376, ~383) in `packages/orchestrator/src/worker/pr-feedback-handler.ts`. Remove the `phaseTracker: PhaseTracker` parameter from the constructor (currently param 4) so ctor becomes 5 positional args per `data-model.md`.
- [X] T002 [US2] Update `PrFeedbackHandler` construction site in `packages/orchestrator/src/worker/claude-cli-worker.ts` to drop the `phaseTracker` argument.
- [X] T003 [P] [US2] Update `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`: drop the `phaseTracker` stub from constructor calls and remove every `expect(phaseTracker.clear)…` assertion on the five terminal paths. Assertions must continue to cover the non-dedupe handler behavior (branch switch, CLI spawn, commit+push, thread replies, label removal on success).

## Phase 2: Queue adapter log-shape upgrade (FR-009)

- [X] T004 [P] [US2] In `packages/orchestrator/src/services/redis-queue-adapter.ts`, upgrade the `false`-return path of `enqueueIfAbsent` (around lines 140-146) to emit a structured `info` log line: `logger.info({ itemKey, reason: 'in-flight' }, 'Dropping enqueue (item already in flight)')`. Preserve the existing Redis-error `warn` path as a distinct signal — only the non-error `false` return is upgraded.
- [X] T005 [P] [US2] In `packages/orchestrator/src/services/in-memory-queue-adapter.ts`, add the same `info` log line on the `false`-return path of `enqueueIfAbsent` (around lines 82-105) for adapter parity so the FR-009 contract holds in both runtimes.

## Phase 3: Monitor migration (FR-001, FR-002, FR-010, FR-011)

<!-- Phase boundary: Complete Phase 1 and Phase 2 before starting — the ctor signature change and the new info-log contract must be in place first. -->

- [X] T006 [US1] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`, change the constructor field type from `queueAdapter: QueueAdapter` to `queueManager: QueueManager` (widening to reach `enqueueIfAbsent`). Remove the `phaseTracker: PhaseTracker` ctor parameter and field entirely (FR-011). Delete the `DEDUP_PHASE = 'address-pr-feedback'` constant at line 38 (FR-002). Do not alter any other ctor arg positions except the drop of `phaseTracker`.
- [X] T007 [US1] In `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` `processPrReviewEvent` (Case A branch around lines 334-390), reorder `client.addLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback'])` to fire **before** the enqueue call, wrapped in the existing non-fatal try/warn (FR-010). Label add must occur whenever `unresolvedThreadIds.length > 0` regardless of the enqueue outcome.
- [X] T008 [US1, US2] Replace the `phaseTracker.tryMarkProcessed(...) + if (!isNew) skip` block (around lines 341-350) with `const enqueued = await this.queueManager.enqueueIfAbsent(queueItem)`. On `false`, log `logger.info({ itemKey, reason: 'in-flight', prNumber, issueNumber }, 'Dropping PR-feedback enqueue (item already in flight)')` and `return false`; on `true`, keep the existing "PR feedback work enqueued" info log and `return true`. Delete the old "Skipping duplicate — PR feedback already enqueued for this issue" log line.
- [X] T009 In `packages/orchestrator/src/server.ts` around lines 405-417, update the `PrFeedbackMonitorService` construction to drop the `phaseTracker` argument and pass the existing `queueManager` (already threaded through the constructor). Verify the surrounding arg positions still match the new 10-arg ctor from `data-model.md`.

## Phase 4: Regression + audit tests (SC-001…SC-005, FR-009, FR-010)

<!-- Phase boundary: Complete Phase 3 before starting — tests exercise the migrated ctor signature and behavior. -->

- [X] T010 [P] Add `packages/orchestrator/src/__tests__/phase-tracker-audit.test.ts` patterned on `trust-predicate-audit.test.ts`. Assertions (SC-004): (i) `readFileSync` on `packages/orchestrator/src/services/pr-feedback-monitor-service.ts` — must not match the identifier `PhaseTracker`; (ii) `readFileSync` on `packages/orchestrator/src/worker/pr-feedback-handler.ts` — must not match the identifier `PhaseTracker`; (iii) recursive grep under `packages/orchestrator/src/**` — no `DEDUP_PHASE` declaration remains. Do not match the string literal `'address-pr-feedback'` (legitimately survives as the queue command name).
- [X] T011 [US1] Extend `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`: drop the `phaseTracker` stub argument from every `new PrFeedbackMonitorService(...)` construction. Update mock harness to use `InMemoryQueueAdapter` (or a small `QueueManager` fake) so `enqueueIfAbsent` semantics are real for the new dedupe assertions.
- [X] T012 [US1] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add SC-001 stale-key test: pre-populate a `phase-tracker:<owner>:<repo>:<issue>:address-pr-feedback` key in the fake/in-memory Redis with any TTL, run the monitor with a trusted unresolved thread and no in-flight item, assert exactly one `enqueue`-observable item is added on the first poll.
- [X] T013 [US2] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add SC-002 webhook+poll race test: fire two `processPrReviewEvent` invocations against the same PR state (or a webhook path + poll path) with the same `itemKey`, assert queue depth after both resolve equals 1 and exactly one FR-009 `info` drop line is emitted.
- [X] T014 [US2] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add SC-003 handler-terminal → re-enqueue test: simulate handler completion via `queueManager.complete()` / `.release()` on each terminal path (success, failure, drop), then run the monitor with trusted unresolved state, assert `enqueueIfAbsent` returns `true` on the following poll with no manual key clearing.
- [X] T015 [US1] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add SC-005 zero-trusted regression fence: unresolved thread with only untrusted authors → assert no `enqueueIfAbsent` call is made and no queue item is added on any poll. This is the #869 interaction guard that keeps self-clearing dedupe from busy-looping.
- [X] T016 [P] [US2] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add FR-009 log assertion: on the `enqueueIfAbsent → false` path, assert an `info` log call whose object arg contains `{ itemKey: '<owner>/<repo>#<issue>', reason: 'in-flight' }` (from either the adapter-level line or the monitor-level line, per `contracts/enqueue-dedupe.md`).
- [X] T017 [P] [US2] In `packages/orchestrator/src/services/__tests__/pr-feedback-monitor-service.test.ts`, add FR-010 idempotent-label-on-collision assertion: on the `enqueueIfAbsent → false` path, assert `client.addLabels` was still called with `['waiting-for:address-pr-feedback']` for the correct `owner`, `repo`, `issueNumber` — i.e. the label add fires before the enqueue call and survives the drop.

## Phase 5: Verification

- [X] T018 Run `pnpm --filter @generacy-ai/orchestrator typecheck` and `pnpm --filter @generacy-ai/orchestrator test` from repo root. Expect: (i) no `PhaseTracker` type error at the `pr-feedback-monitor-service.ts` or `pr-feedback-handler.ts` call sites, (ii) the new audit test T010 passes, (iii) all SC-001…SC-005 regression tests pass, (iv) FR-009 and FR-010 log assertions pass in both adapters.

## Dependencies & Execution Order

**Sequential dependencies:**
- Phase 1 (handler cleanup + ctor drop) → Phase 3 (monitor migration) — the audit test in Phase 4 forbids `PhaseTracker` in the handler, so the handler cleanup must land before the audit test runs.
- Phase 2 (adapter log-shape upgrade) → Phase 4 (log-assertion tests) — the FR-009 tests read the adapter-level log line.
- Phase 3 (monitor migration) → Phase 4 (regression tests) — the tests instantiate the new ctor signature and exercise `enqueueIfAbsent`.
- T009 (`server.ts` wiring) depends on T006 (ctor signature change).
- T002 (`claude-cli-worker.ts` wiring) depends on T001 (handler ctor change).

**Parallel opportunities:**
- **Inside Phase 1**: T003 (handler test) can run in parallel with T001/T002 once the ctor shape is agreed — mark [P].
- **Phase 1 T001-T002 vs. Phase 2 T004-T005**: fully independent file sets, can be done in parallel.
- **Inside Phase 2**: T004 and T005 touch different adapter files — parallel [P].
- **Inside Phase 4**: T010 (audit test) is a standalone new file, parallel with the monitor-service test edits — marked [P]. T016 and T017 are additive assertions in the same test file as T011-T015, so they run sequentially with those but can be authored alongside them once the harness in T011 is in place — marked [P] to signal "no cross-task dependency beyond T011".

**Critical path**: T001 → T002 → T006 → T007 → T008 → T009 → T011 → (T012, T013, T014, T015) → T018.
