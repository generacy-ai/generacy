# Tasks: Address-pr-feedback flow must not advance implementation-review gate

**Input**: Design documents from `/specs/941-summary-during-snappoll/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = request-changes holds the gate; US2 = loud diagnostic when gate label stripped)

## Phase 1: Foundation — types + predicate in `LabelManager`

- [ ] T001 [US1] Add `AllowGateComplete` frozen-object + type + `HumanGateCompletionUnauthorizedError` class near the top of `packages/orchestrator/src/worker/label-manager.ts`. Exact shape per `specs/941-summary-during-snappoll/data-model.md` §Core additions. All three are new exports; `AllowGateComplete` has exactly one member (`CockpitAdvance: 'cockpit-advance'`) — do NOT add other members.
- [ ] T002 [US1] In the same `packages/orchestrator/src/worker/label-manager.ts`, add the module-const `HUMAN_GATE_SUFFIXES` (computed from `Object.keys(GATE_MAPPING)` ∪ every `Object.keys(WORKFLOW_GATE_MAPPING[*])`, imported from `./phase-resolver.js`) and the exported predicate `isHumanGateCompletion(label: string): boolean`. Per `data-model.md` §HUMAN_GATE_SUFFIXES. Sequential with T001 (same file).

## Phase 2: Core Implementation

- [ ] T003 [US1] Modify `LabelManager.applyLabels` signature in `packages/orchestrator/src/worker/label-manager.ts` to accept `allow?: AllowGateComplete` (second, optional param). Add the pre-network guard branch: when `allow == null`, iterate `labels` and throw `HumanGateCompletionUnauthorizedError(label)` for any `isHumanGateCompletion(label)` hit BEFORE the existing lineage-map enrichment + `this.github.addLabels(...)` call. Do NOT change public methods (`onPhaseStart`, `onPhaseComplete`, `onGateHit`, `onError`, `onResumeStart`, `ensureCleanup`, `ensureRepoLabelsExist`) — none of them need to thread the token today. See contract `contracts/label-manager-guard.md` §Signature change + §Invariants. Depends on T001 + T002.

- [ ] T004 [US2] In `packages/orchestrator/src/worker/pr-feedback-handler.ts`, add module-level constant `WAITING_FOR_IMPLEMENTATION_REVIEW_LABEL = 'waiting-for:implementation-review'` and the new private method `PrFeedbackHandler.ensureImplementationReviewGate(github, owner, repo, issueNumber, prNumber)` — exact body per `data-model.md` §New private method. MUST NOT throw (mirrors `clearInProgressLabel` / `removeFeedbackLabel` shape). Log fields: `{ event: 'gate-label-missing-at-fix-exit', owner, repo, issueNumber, pr: prNumber }` at `error` level per contract `contracts/pr-feedback-gate-reassertion.md` §Log event shape.

- [ ] T005 [US2] In the same `packages/orchestrator/src/worker/pr-feedback-handler.ts`, wire the call `await this.ensureImplementationReviewGate(github, owner, repo, issueNumber, prNumber)` into the shared `finally` block of `handle()` (around lines 411-416, added by #926). Ordering is load-bearing: MUST be called BEFORE `this.clearInProgressLabel(...)` so the terminal transient state is never `{ agent:in-progress present, waiting-for:implementation-review absent }`. See `contracts/pr-feedback-gate-reassertion.md` §Ordering constraint. Depends on T004 (same file, sequential).

## Phase 3: Tests

- [ ] T006 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/label-manager.guard.test.ts` (NEW). FR-007 unit tests covering: (a) each of the 7 human-gate suffixes (`clarification`, `spec-review`, `plan-review`, `tasks-review`, `implementation-review`, `sibling-review`, `merge-conflicts`) → `completed:<X>` token-less rejected with `HumanGateCompletionUnauthorizedError`; (b) each with `AllowGateComplete.CockpitAdvance` → passes through to `github.addLabels`; (c) each `WorkflowPhase` (`specify`, `clarify`, `plan`, `tasks`, `implement`, `validate`) → `completed:<phase>` allowed token-less; (d) non-`completed:*` labels (`phase:*`, `waiting-for:*`, `agent:*`, `failed:*`, `blocked:*`) → unaffected; (e) batched call `['agent:paused', 'completed:implementation-review']` without token → whole call throws, no partial writes. Depends on T003.

- [ ] T007 [P] [US2] Create `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.gate-reassert.test.ts` (NEW). FR-002 unit tests for `ensureImplementationReviewGate` behavior. Cases per contract `contracts/pr-feedback-gate-reassertion.md` §Test surface: (1) happy path, gate present → no re-add, no `error` log; (2) happy path, gate missing → exactly one `error` log with `event: 'gate-label-missing-at-fix-exit'` + one `addLabels(..., ['waiting-for:implementation-review'])` call; (3) Case B (no diff, `spawnClaudeForFeedback` returns false), gate missing → same log + re-add; (4) thrown-error path (`commitAndPushChanges` throws) → `finally` still runs check + re-add; (5) `getIssue` throws → `warn` log, no re-add, no crash; (6) `addLabels` re-add throws → `warn` log, `finally` completes without throwing. Depends on T005.

- [ ] T008 [P] [US1] Create `packages/orchestrator/src/__tests__/pr-feedback-gate-invariant.integration.test.ts` (NEW). FR-005 integration regression. Driver: `PhaseLoop` or `ClaudeCliWorker` (whichever gives the shortest path to enqueueing a simulated `address-pr-feedback` queue item — per plan §FR-005). Mocks: `GitHubClient` that records `addLabels`/`removeLabels` into an ordered edit log; `AgentLauncher` that returns a child exiting 0 with no diff (simulating "fix session ran but findings not resolved"). Preload the mock issue with `{ waiting-for:implementation-review, waiting-for:address-pr-feedback, agent:in-progress, agent:paused }` and unresolved review threads. Drive one full cycle. Assertions: (a) final terminal state (union of adds − removes) = `{ waiting-for:implementation-review, agent:paused }`; (b) NO `addLabels(..., ['completed:implementation-review'])` call on ANY exit branch. Depends on T005 (needs the wired handler).

## Phase 4: Validation

- [ ] T009 Run `pnpm --filter @generacy-ai/orchestrator typecheck` and `pnpm --filter @generacy-ai/orchestrator test` from repo root. All three new test files must pass; no existing tests may regress. Depends on T006 + T007 + T008.

- [ ] T010 [US1] SC-002 static verification: `grep -RIn "AllowGateComplete.CockpitAdvance" packages/ --include='*.ts' --exclude-dir='__tests__'` MUST return **zero** hits (the token exists as a type export only; no production caller uses it today). Depends on T003.

- [ ] T011 [US1] SC-003 deliberate-regression check: temporarily insert `await github.addLabels(owner, repo, issueNumber, ['completed:implementation-review']);` into `PrFeedbackHandler.handle()`'s happy-path branch, run the FR-005 test from T008 — it MUST go red with a message naming the offending write. Revert the insertion before committing. Depends on T008.

## Dependencies & Execution Order

**Sequential chain (Phases 1 → 2):**
- T001 → T002 → T003 (all in `label-manager.ts`, same file, must land in order)
- T004 → T005 (both in `pr-feedback-handler.ts`, same file, must land in order)
- T003 and T004 can run in parallel (different files), but the plan pairs them into one PR.

**Parallel opportunities in Phase 3:**
- T006, T007, T008 can be authored concurrently — three separate test files, no shared imports beyond public API.
- T006 depends on T003; T007 + T008 depend on T005. If T003 and T005 land, all three tests can be written in parallel.

**Validation (Phase 4):**
- T009 waits for all Phase 3 tests to be written.
- T010 waits only on T003 (token type exists).
- T011 waits on T008 (integration test exists and passes).

**Total: 11 tasks across 4 phases.**

## Next step

Run `/speckit:implement` (or the appropriate implement command) to execute this task list.
