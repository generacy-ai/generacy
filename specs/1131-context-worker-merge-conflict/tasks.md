# Tasks: Merge-conflict re-arm targets a resolution-scoped review

**Input**: Design documents from `/specs/1131-context-worker-merge-conflict/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/review-scope.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Dependency note

This issue only *re-arms into* the engine-native `review`/`remediate` machinery
from epic #1120 (#1121 phase plumbing + `reviewPhaseEnabled`, #1124 review
executor + charter + findings artifact, #1125 PR posting + draft/ready, #1126
re-review convergence, #1127 integration). All are expected merged to `develop`.
If any is missing on the base branch at implement time, dependency-block until it
lands (spec Assumptions).

---

## Phase 1: Type surface (data-model.md)

- [X] T001 [P] [US3] Add `ReviewScope` value object (`{ readonly baseSha: string; readonly headSha: string }`) and an optional `reviewScope?: ReviewScope` field on `ReArmedOutcome` in `packages/orchestrator/src/worker/handler-outcome.ts`.
- [X] T002 [P] [US3] In `packages/orchestrator/src/worker/types.ts`: widen `WorkerContext.resumeReason` union to include `'merge-conflict-resolved'`, and add `reviewScope?: ReviewScope`. Import/re-use the `ReviewScope` type from `handler-outcome.ts` (avoid a duplicate definition).
- [X] T003 [P] [US1] In `packages/orchestrator/src/worker/review-charter.ts`: add optional `diffWindow?: { baseSha: string; headSha: string }` to `ReviewCharterInput` (type/interface only; behavior wired in Phase 4).
- [X] T004 [P] [US3] In `packages/orchestrator/src/types/monitor.ts`: add a documentation-only comment on `ResolveMergeConflictsMetadata` (67–85) stating the resolution base/head SHAs travel via the re-armed outcome's `reviewScope`, **not** the sidecar (cleared immediately after re-arm); `phase?` stays required for the fail-loud guard and flag-OFF fallback. No new sidecar field.

## Phase 2: Handler — compute scope + choose re-arm target (US1, US3)

- [X] T005 [US3] Add a `getResolutionScope(checkoutPath)` helper in `packages/orchestrator/src/worker/merge-conflict-handler.ts`: returns `{ baseSha: HEAD^1, headSha: HEAD }` from the `--no-ff` merge commit (short SHAs via `git rev-parse --short`, consistent with `getBranchTipSha`); returns `{ baseSha: HEAD, headSha: HEAD }` for the no-op path (`:227-233`); returns `undefined` when either SHA can't be determined (whole-branch fallback, FR-010 — do NOT fail loud).
- [X] T006 [US1] In `finishSuccess` (`merge-conflict-handler.ts:631-660`), replace the fixed `startPhase: metadata.phase` re-arm (`:659`) with a target choice gated on `this.config.reviewPhaseEnabled`: flag ON → `{ outcome: 're-armed', startPhase: 'review', reviewScope: getResolutionScope(...) }` (reviewScope omitted when the helper returns `undefined`); flag OFF → `{ outcome: 're-armed', startPhase: metadata.phase }` (byte-identical to today, FR-009). Keep the fail-loud guard (`:641-656`) and its `metadata.phase` requirement unchanged (FR-010).
- [X] T007 [US1] Verify the failure/blocked disposition (`blocked:stuck-merge-conflicts`, preserved `waiting-for:merge-conflicts`, evidence emission) is untouched by the T005/T006 edits (FR-008, SC-005).

## Phase 3: Worker wiring — transport + explicit start-phase override (US1, US3)

- [X] T008 [US3] In `packages/orchestrator/src/worker/claude-cli-worker.ts` rearm-item build (`:380-394`): carry `startPhase: outcome.startPhase`, `resumeReason: 'merge-conflict-resolved'`, and `reviewScope: outcome.reviewScope` into `rearmItem.metadata`.
- [X] T009 [US1] In the `claude-cli-worker.ts` context-build seam (~`:522-537`, where `md['resumeReason']`/`md['baseSha']` are read): set `context.resumeReason = 'merge-conflict-resolved'` when so; apply the **explicit start-phase override** — when `md['resumeReason'] === 'merge-conflict-resolved'` AND `md['startPhase'] === 'review'`, set `context.startPhase = 'review'` directly, bypassing the label-derived `resolveStartPhase` result (`:439`); set `context.reviewScope = md['reviewScope']` (may be `undefined`). Any other `resumeReason`/`startPhase` → label-derived start phase unchanged (Contract A).
- [X] T010 [US1] Confirm `assertHandlerOutcomeMatchesWorld` (`handler-outcome-assertion.ts:43-56`) stays green: `rearmItem.metadata.startPhase === outcome.startPhase` by construction — no change should be needed, but verify against the new `review` re-arm.

## Phase 4: Review executor + charter — scoped diff window (US1)

- [X] T011 [US1] In `packages/orchestrator/src/worker/review-executor.ts` `execute(context)` (~`:58`): read `context.reviewScope`. When **present**, run `git diff --name-only <baseSha>..<headSha>` (or `--quiet`) in the checkout; **empty window** → short-circuit (no CLI spawn, no findings artifact, return a synthetic success PhaseResult so the loop advances to `validate` — FR-011, SC-004), do NOT apply the "empty diff = blocking finding" rule. **Non-empty** → pass `diffWindow: { baseSha, headSha }` to the charter and spawn as today. When **absent** (`undefined`) → whole-PR review as today (FR-010).
- [X] T012 [US1] In `buildReviewCharter` (`review-charter.ts`): when `input.diffWindow` is present, name the exact `baseSha..headSha` range as the review target, replacing the whole-PR-diff language (FR-002); leave the forbid-tests/builds clause (`:43-49`, FR-007) and sidecar-write instruction unchanged. Absent `diffWindow` → byte-identical to today.

## Phase 5: Changeset

- [X] T013 [P] Add `.changeset/1131-merge-conflict-review-rearm.md` — `@generacy-ai/orchestrator` **patch** (internal handler/worker/executor/charter behavior; `reviewScope`/`diffWindow` are orchestrator-internal, not re-exported). Confirm at implement time that no new public export was added; if one was, bump accordingly.

## Phase 6: Tests & verification (SC-001..005)

- [X] T014 [US1] Update `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.rearm.test.ts` fixtures: flag ON → expect `startPhase: 'review'` + `reviewScope` ({baseSha,headSha}); flag OFF → expect unchanged `startPhase: metadata.phase` and no `reviewScope`. Also cover the undetermined-SHA fallback (flag ON, `reviewScope` omitted) and the no-op empty-window scope.
- [X] T015 [US1][US2] SC-001 + SC-004: integration test driving conflict → resolve → scoped `review` → `validate` (full traversal), asserting the phase sequence and that the clean-review branch lands in `validate` (no bypass to ready/merge). Place alongside existing merge-conflict/phase-loop integration tests in `packages/orchestrator/src/worker/__tests__/`.
- [X] T016 [P] [US1] SC-002: assertion that the scoped review's diff window excludes files unrelated to the resolution diff — fixture with unrelated branch files, assert the charter/executor window is `baseSha..headSha` only.
- [X] T017 [P] [US1] SC-003: assertion that no build or test process is spawned during resolution itself (spy on process spawns across the resolution attempt; git-state-only predicate preserved — FR-007).
- [X] T018 [P] [US2] SC-005: regression asserting the blocked path (`blocked:stuck-merge-conflicts`) disposition is byte-identical to today.
- [X] T019 [P] [US1] Test the empty-window short-circuit (FR-011): a defined-but-empty `{baseSha,headSha}` window skips the review executor and proceeds directly to `validate`, and does NOT emit an "empty diff = blocking finding".

## Dependencies & Execution Order

**Phase order (sequential):**
- Phase 1 (types) → Phase 2 (handler) → Phase 3 (worker wiring) → Phase 4 (executor/charter). Phase 4 consumes `context.reviewScope` set in Phase 3; Phase 3 consumes the outcome shape from Phases 1–2.
- Phase 5 (changeset) can be written any time after Phase 1; grouped late for convenience.
- Phase 6 (tests) after the implementation phases; individual `[P]` tests are independent files.

**Parallel opportunities:**
- Phase 1: T001–T004 touch four different files → all `[P]`.
- Phase 6: T016, T017, T018, T019 are independent test files/assertions → `[P]`. T014 and T015 have ordering/fixture overlap with the handler and phase-loop, keep sequential-ish.

**Critical path:** T001/T002 → T005 → T006 → T008 → T009 → T011 → T012 → T015.

## Grouping Strategy for Issue Creation

Default `per-story` grouping applies (no `epic-grouping:*` label). US3 = type/transport plumbing, US1 = handler + wiring + executor/charter + most tests, US2 = the validate-invariant assertions.
