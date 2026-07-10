# Tasks: `MergeConflictHandler` success path re-arms the interrupted phase (`#902`)

**Input**: Design documents from `/specs/902-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/handler-outcome.md, contracts/rearm-flow.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 only in this ship)

---

## Phase 1: Type foundations

Pure additions — no consumers yet, compiles green. Unblocks every downstream task.

- [X] T001 [P] [US1] Add `HandlerOutcome` discriminated union in `packages/orchestrator/src/worker/handler-outcome.ts` (NEW). Exports `HandlerOutcome`, `ReArmedOutcome`, `GatedOutcome`, `FailedOutcome`, `DoneOutcome` per `data-model.md` §"HandlerOutcome (FR-005)". Imports `WorkflowPhase` from `./types.js`, `QueueItem` from `../types/index.js`, `BlockedStuckMergeConflictsEvidence` from `./merge-conflict-handler.js`.

- [X] T002 [P] [US1] Add `assertHandlerOutcomeMatchesWorld` runtime helper in `packages/orchestrator/src/worker/handler-outcome-assertion.ts` (NEW). Exports `QueueSnapshot`, `AssertionResult`, `assertHandlerOutcomeMatchesWorld(outcome, labels, queueSnapshot): AssertionResult` per `data-model.md` §"assertHandlerOutcomeMatchesWorld (FR-006)". Pure function; per-variant rules from the table in data-model. Depends on T001 for the type import.

- [X] T003 [P] [US1] Add `phase?: WorkflowPhase` field to `ResolveMergeConflictsMetadata` in `packages/orchestrator/src/types/monitor.ts` (MODIFIED). Additive-optional at parse time per `data-model.md` §"ResolveMergeConflictsMetadata (FR-003)". Import `WorkflowPhase` from the worker types module if not already in scope.

- [X] T004 [P] [US1] Add `postComplete?: PostCompleteAction` to `CompletedResult` and export `PostCompleteAction = { kind: 'rearm'; rearmItem: QueueItem }` in `packages/orchestrator/src/worker/worker-result.ts` (MODIFIED). Shape per `data-model.md` §"WorkerResult — new postComplete variant".

- [X] T005 [P] [US1] Add pause-context schema + reader/writer in `packages/orchestrator/src/worker/pause-context.ts` (NEW). Zod schema `PauseContextSchema` = `{ phase: WorkflowPhaseSchema, writtenAt: string, issueRef: string }`. Exports `writePauseContext(store, workflowId, ctx)` and `readPauseContext(store, workflowId): PauseContext | null`. File layout: `<checkoutPath>/.generacy/pause-context-<workflowId>.json` per `data-model.md` §"Pause-context sidecar". Invalid JSON → returns `null` (fail-loud path fires downstream).

---

## Phase 2: Producer + consumer of the pause context

<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

Depends on T003 + T005.

- [X] T006 [US1] Persist pause-context at pause site in `packages/orchestrator/src/worker/phase-loop.ts` (`runPrePhaseBaseMerge`, ~lines 912–968). Call `writePauseContext(store, workflowId, { phase, writtenAt: new Date().toISOString(), issueRef })` **before** `labelManager.onGateHit(...)` (~line 961). If the write throws, do NOT apply the pause label — the pause simply doesn't materialize (no dead-park class introduced). Per plan Sequencing step 4.

- [X] T007 [US1] Read pause-context at worker dispatch in `packages/orchestrator/src/worker/claude-cli-worker.ts` (`case 'resolve-merge-conflicts'`, ~lines 313–339). After `git checkout` completes, load state via `FilesystemWorkflowStore(checkoutPath)` and call `readPauseContext(...)`. If present, populate `item.metadata.phase`. If absent, leave undefined — the handler's fail-loud path (T008) will fire. Per plan Sequencing step 5.

---

## Phase 3: Handler + dispatcher wiring

<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

Depends on T001, T004, T007.

- [X] T008 [US1] Change `MergeConflictHandler.handle` return type from `Promise<void>` to `Promise<HandlerOutcome>` and update every terminal branch in `packages/orchestrator/src/worker/merge-conflict-handler.ts` (line 115 signature; all `apply*Disposition` return sites). Mapping from `data-model.md` §"MergeConflictHandler.handle return type" table:
  - success/no-op/pushAndSucceed success → `{outcome: 're-armed', startPhase: metadata.phase}`
  - all `applyBlockedDisposition` branches → `{outcome: 'failed', evidence: ...}`
  - **Fail-loud path (FR-004)**: if `metadata.phase` is `undefined` when a `re-armed` outcome would be returned, return `{outcome: 'failed', evidence: { ...blockedEvidence, reason: 'pause-context missing: phase' }}` and land the issue at `blocked:stuck-merge-conflicts` — never re-derive from labels.

- [X] T009 [US1] Replace two-call `addLabels`/`removeLabels` pair in `applySuccessDisposition` (~lines 596–625 of `packages/orchestrator/src/worker/merge-conflict-handler.ts`) with a single combined `gh issue edit --remove-label completed:merge-conflicts --remove-label waiting-for:merge-conflicts --remove-label agent:in-progress --remove-label agent:paused` invocation. **No adds** on the success path per `research.md` Decision 4 (direct enqueue, not resume-pair). If the label helper cannot combine, split with add-before-remove ordering per `#849`. Landmark of FR-001, FR-007. Depends on T008 (touches the same file — sequence, don't parallelize).

- [X] T010 [US1] Build the `WorkerResult` with `postComplete: { kind: 'rearm', rearmItem }` in the `case 'resolve-merge-conflicts'` branch of `packages/orchestrator/src/worker/claude-cli-worker.ts` (~lines 313–339). On `HandlerOutcome 're-armed'`, construct `rearmItem = { ...item, command: 'continue', metadata: { startPhase: outcome.startPhase, ... } }` and return `{ status: 'completed', postComplete: { kind: 'rearm', rearmItem } }`. On `failed` → return `{ status: 'failed-terminal', failureMetadata }`. Order at the call site: **build the WorkerResult with the postComplete payload BEFORE calling `applySuccessDisposition`** so that if label cleanup crashes, the recovery path (existing `LabelManager.onResumeStart`) still runs cleanly (FR-008). Depends on T008. Same file as T007 — sequence after T007.

- [X] T011 [US1] Fire `postComplete` in `WorkerDispatcher.runWorker` in `packages/orchestrator/src/services/worker-dispatcher.ts` (~line 389, after `queue.complete(workerId, item)`). Add:
  ```typescript
  if (result.status === 'completed' && result.postComplete?.kind === 'rearm') {
    await this.queue.enqueueIfAbsent(result.postComplete.rearmItem);
  }
  ```
  Dispatcher stays agnostic to the *meaning* — just enqueues whatever the worker built (`data-model.md` §"WorkerResult — new postComplete variant"). Depends on T004.

---

## Phase 4: Regression tests

<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

Depends on Phase 3 (handler + dispatcher wiring complete). Fixtures wrap terminal snapshots with `assertHandlerOutcomeMatchesWorld` from T002.

- [X] T012 [US1] Update existing fixtures in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.test.ts` (MODIFIED) to assert the new `HandlerOutcome` return at every terminal branch and attach `assertHandlerOutcomeMatchesWorld` to every terminal state check (FR-006).

- [X] T013 [P] [US1] Add end-to-end re-arm fixture in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.rearm.test.ts` (NEW). Drives: pause → handler success (agent-resolved) → worker enqueues `continue` → phase-loop re-runs the interrupted phase. Assert the phase-loop re-entry is observable in worker logs (SC-002), not merely inferred from handler exit code (spec Regression tests §1).

- [X] T014 [P] [US1] Add no-op branch fixture in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.noop.test.ts` (NEW). Same drive as T013 but with `baseIsAncestor === true` at handler entry. Asserts identical downstream state to the resolved-by-agent path (SC-001, spec Regression tests §2).

- [X] T015 [P] [US1] Add second-cycle regression fixture in `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.second-cycle.test.ts` (NEW). Fires two conflict pauses on the same issue in sequence. The second must hit the handler again — no stale-marker insta-resume through the generic pair path (SC-003, spec Regression tests §4, FR-001 load-bearing test).

- [X] T016 [P] [US1] Add `PrFeedbackHandler` assertion-only coverage in `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.assertion.test.ts` (NEW). Wraps existing terminal-state fixtures with `assertHandlerOutcomeMatchesWorld` mapped from fixture inputs. **No handler signature change** — assertion-only per FR-009.

---

## Dependencies & Execution Order

**Sequential phase gates**:
- Phase 1 (T001–T005) → Phase 2 (T006–T007) → Phase 3 (T008–T011) → Phase 4 (T012–T016)

**Parallel opportunities**:
- Phase 1: T001, T002, T003, T004, T005 are all independent (5 new/modified files, no cross-deps beyond T002 importing T001's type). Run in parallel.
- Phase 2: T006 (phase-loop) and T007 (claude-cli-worker) touch different files; T007 depends on the pause-context reader from T005. Can run in parallel with each other once Phase 1 is complete.
- Phase 3: T008 → T009 → T010 sequenced (all touch handler + worker files); T011 (dispatcher) parallel with T008/T009/T010.
- Phase 4: T012 (modification of existing test) sequenced first; T013, T014, T015, T016 are independent new files — parallelize.

**Critical path**: T003 → T005 → T007 → T008 → T010 → T012.

**Ship boundary**: single PR. Not decomposable per plan §"Ship boundaries" — removing `completed:merge-conflicts` without re-arm dead-parks; re-arm without clearing `agent:in-progress` creates ownership races; re-arm without the runtime assertion (T002 + Phase 4) ships the same bug class.

---

*Generated by /speckit:tasks — standard mode (bugfix workflow)*
