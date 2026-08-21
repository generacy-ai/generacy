# Tasks: Merge-conflict scoped-review lifecycle fixes

**Input**: Design documents from `/specs/1164-severity-major-p2-merge/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - US1 = Defect 1 (stale `reviewScope`, FR-001/FR-002)
  - US2 = Defect 2 (base-delta scope, FR-003)
  - US3 = Defect 3 (trivial-diff rule, FR-004/FR-005)
  - US4 = Defect 4 (validate bypass + crash window, FR-006/FR-007/FR-008)

## Phase 1: Type Seams (foundational — unblock everything else)

- [X] T001 [P] [US2] Extend `ReviewScope` in `packages/orchestrator/src/worker/handler-outcome.ts`
  with `readonly conflictedPaths?: readonly string[]` (per `contracts/review-scope.md` and
  `data-model.md §1`). Optional/absent by default so non-merge-conflict scopes are unchanged.
- [X] T002 [P] [US4] Extend the `rearm` variant of `PostCompleteAction` in
  `packages/orchestrator/src/worker/worker-result.ts` with `readonly afterEnqueue?: () => Promise<void>`
  (per `contracts/success-disposition.md` and `data-model.md §2`). Optional closure; dispatcher
  has no `GitHubClient` in worker mode, so the worker builds it.

## Phase 2: Core Implementation
<!-- Phase boundary: Complete Phase 1 (type seams) before starting Phase 2 -->

### Defect 1 — remediation convergence (US1)

- [X] T003 [US1] In `packages/orchestrator/src/worker/review-executor.ts` (~`:80-199`), move the
  `priorRound = await readReviewArtifact(...)` read **before** the `reviewScope` branch. Compute
  `useScope = context.reviewScope != null && !priorRound` and gate the empty-window short-circuit
  (`:98-113`), the delta pauseContext (`:137-144`), and the charter `diffWindow` (`:170`) all on
  `useScope`. Round 2+ falls back to the standard #1126 `lastReviewedCommitSha`..HEAD delta.
  Per `contracts/scoped-review-lifecycle.md`. (FR-001/FR-002)

### Defect 2 — conflicted-path allowlist (US2)

- [X] T004 [US2] In `packages/orchestrator/src/worker/merge-conflict-handler.ts`, thread the live
  `conflictedPaths` local (enumerated at `:275-291` via `git diff --name-only --diff-filter=U`)
  through `pushAndSucceed` (`:389`) → `finishSuccess` → `getResolutionScope` (`:940-960`). Populate
  `ReviewScope.conflictedPaths` **only** on the post-conflict-resolution success path; leave it
  absent on the no-op (`:232`) and clean-merge (`:269`) success paths. Per `contracts/review-scope.md`
  producer contract. (FR-003)

### Defect 3 — trivial-diff suppression + allowlist rendering (US3)

- [X] T005 [US3] In `packages/orchestrator/src/worker/review-charter.ts` (~`:143-154`): (a) emit the
  "Empty or trivial diff → blocking finding" paragraph only when `!verification && !diffWindow`
  (whole-PR round-1 only) — FR-004; (b) when `diffWindow.conflictedPaths` is non-empty, render the
  charter naming the allowlist ("Inspect ONLY these conflicted paths … Ignore all other files") and
  list each path instead of the raw `baseSha..headSha` range; fall back to the pre-#1164 range
  description when `conflictedPaths` is empty/absent (FR-009). Per `contracts/review-scope.md`
  consumer contract. (FR-003/FR-004/FR-005)

### Defect 4 — validate-bypass + crash-window (US4)

- [X] T006 [US4] In `packages/orchestrator/src/worker/merge-conflict-handler.ts` `applySuccessDisposition`
  (`:691-714`): (a) ADD `completed:validate` and `completed:implementation-review` (file-local literal
  `const`s next to existing label imports — no new shared vocabulary) to the `github.removeLabels`
  batch so the #1133 terminal short-circuit no longer fires on the post-merge tree — FR-007; (b) REMOVE
  `AGENT_IN_PROGRESS_LABEL` / `AGENT_PAUSED_LABEL` from this batch (they move to the `afterEnqueue`
  closure in T007) — FR-008. Per `contracts/success-disposition.md` and `data-model.md §3`.
  (FR-006/FR-007/FR-008)
- [X] T007 [US4] In `packages/orchestrator/src/worker/claude-cli-worker.ts` (~`:414-450`), build the
  `afterEnqueue` closure that calls `github.removeLabels(owner, repo, issueNumber, [AGENT_IN_PROGRESS_LABEL,
  AGENT_PAUSED_LABEL])` and attach it to the rearm `postComplete` object. Depends on T002 (type) and T006
  (labels no longer cleared in disposition). (FR-008)
- [X] T008 [US4] In `packages/orchestrator/src/services/worker-dispatcher.ts` (success path ~`:460-509`),
  invoke `result.postComplete.afterEnqueue?.()` **after** `enqueueIfAbsent` resolves — on both
  `enqueued === true` and the dropped `enqueued === false` case, wrapped in its own try/catch (best-effort,
  log at warn). Do NOT run it if `enqueueIfAbsent` threw (outer catch), so ownership labels survive for the
  next poll. Depends on T002. Per `contracts/success-disposition.md` FR-008 ordering. (FR-008)

## Phase 3: Tests
<!-- Phase boundary: Complete Phase 2 (core changes) before starting Phase 3 -->

- [X] T009 [P] [US1] Add/extend `packages/orchestrator/src/worker/__tests__/phase-loop.merge-conflict-scoped-review.*.test.ts`
  for convergence: scoped review round 1 → `changes-required` → remediation commit fixes the defect →
  round 2 window (real-git) includes the remediation commit SHAs → verdict `clean` → loop advances past
  `review` and does not hit the remediation cap. (SC-001, FR-002)
- [X] T010 [P] [US2][US3] Add `packages/orchestrator/src/worker/__tests__/review-charter.scoped.test.ts`:
  assert a windowed charter over a large-base-delta merge names exactly the conflicted paths (0 base-only
  files — SC-002) and omits the trivial-diff paragraph (SC-003); assert a `ReviewScope` with no
  `conflictedPaths` produces the pre-#1164 range charter byte-for-byte (FR-009). (SC-002/SC-003)
- [X] T011 [P] [US4] Add `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.success-disposition.test.ts`:
  assert the `applySuccessDisposition` remove-labels batch includes `completed:validate` +
  `completed:implementation-review` and no longer includes `agent:in-progress` / `agent:paused`. (FR-007)
- [X] T012 [P] [US4] Add `packages/orchestrator/src/worker/__tests__/merge-conflict-handler.rearm-crash-window.test.ts`:
  assert the rearm `postComplete` carries an `afterEnqueue` closure that clears the ownership labels and that
  `applySuccessDisposition` no longer does. (FR-008)
- [X] T013 [P] [US4] Add `packages/orchestrator/src/services/__tests__/worker-dispatcher.rearm-afterenqueue.test.ts`:
  assert `afterEnqueue` is invoked strictly after `enqueueIfAbsent`, on both enqueued and dropped outcomes,
  and NOT at all when `enqueueIfAbsent` throws. (SC-005, FR-008 ordering)
- [ ] T014 [US4] Add an integration assertion (in the T009 suite or a sibling phase-loop test) that with
  `ciMergeGateEnabled=true` and `reviewPhaseEnabled=false`, a post-resolution re-arm runs `validate` on the
  merged tree before mark-ready (short-circuit suppressed by FR-007). (SC-004)

## Phase 4: Verification & Polish
<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

- [ ] T015 [P] Add changeset `.changeset/1164-merge-conflict-scoped-review-lifecycle.md` —
  `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`). Internal-only fixes: `ReviewScope` /
  `PostCompleteAction` gain optional fields but are not re-exported at the package public boundary; no new
  label vocabulary; no new public exports. Verify with `pnpm changeset status`.
- [ ] T016 Run the full check gate for the package: `pnpm --filter @generacy-ai/orchestrator test`,
  typecheck, and lint. Confirm SC-006 — existing whole-PR / flag-ON review tests pass unchanged (no
  regression). Reconcile any failures before shipping.

## Dependencies & Execution Order

**Phase boundaries** (sequential): Phase 1 → Phase 2 → Phase 3 → Phase 4.

**Phase 1** (parallel): T001 and T002 touch different files (`handler-outcome.ts`, `worker-result.ts`) — run in parallel.

**Phase 2** dependencies:
- T004, T005 depend on T001 (`ReviewScope.conflictedPaths`).
- T003 is independent of T001/T002 (only reorders reads in `review-executor.ts`) — can start once Phase 1 begins.
- T006 → T007 (T007 moves labels T006 removed) → both `merge-conflict-handler.ts` (T004, T006) so keep sequential within that file.
- T007 depends on T002; T008 depends on T002.
- Within Phase 2, `merge-conflict-handler.ts` is touched by T004 and T006 — sequence those two (same file). T003 (`review-executor.ts`), T005 (`review-charter.ts`), T008 (`worker-dispatcher.ts`) are separate files and can proceed alongside.

**Phase 3** (mostly parallel): T009–T013 are separate test files → `[P]`. T014 extends the T009 suite, so run after/with T009.

**Phase 4**: T015 (changeset) is independent `[P]`; T016 (full gate) runs last.

## Parallel opportunities

- Phase 1: T001 ∥ T002.
- Phase 3: T009, T010, T011, T012, T013 all `[P]` (distinct test files).
- Phase 4: T015 `[P]` with the tail of Phase 3.

## Next step

`/speckit:implement` to begin execution.

---

*Generated by speckit*
