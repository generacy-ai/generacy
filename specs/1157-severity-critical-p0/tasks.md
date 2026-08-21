# Tasks: Red CI must not silently complete the workflow

**Input**: Design documents from `/specs/1157-severity-critical-p0/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 Add changeset `.changeset/1157-red-ci-pause.md` — `@generacy-ai/orchestrator`
  **patch** + `@generacy-ai/workflow-engine` **patch** (defect fix, no new public
  exports; union widening is a semantic correction of already-passed-through values).
  Copy the shape of a comparable existing `.changeset/*.md`.

## Phase 2: Foundational (independent pure changes — no dependency on the P0 phase-loop work)
<!-- Phase boundary: none of these depend on each other's files; all [P]. They unblock the FR-006/FR-007 tests. -->

- [X] T002 [P] [US3] FR-006: widen `CiConclusion` union in
  `packages/workflow-engine/src/types/github.ts` (~lines 219-227) to add
  `'startup_failure' | 'stale'` as first-class recognized conclusions.
- [X] T003 [P] [US3] FR-006: add `'startup_failure'` and `'stale'` to
  `FAILING_CONCLUSIONS` in
  `packages/workflow-engine/src/actions/github/client/ci-verdict.ts` (~lines 13-18).
  Leave `IGNORED_CONCLUSIONS` (`skipped`, `neutral`) unchanged. Precedence unchanged;
  only rule-1 failing set grows (see contracts/ci-verdict.md truth table).
- [X] T004 [P] [US4] FR-007 guard: in `evaluateCiReadiness` in
  `packages/orchestrator/src/worker/ci-merge-readiness.ts`, after `aggregateCiVerdict`,
  downgrade a would-be `green` to `not-passed` **only when** `source === 'actions-runs'`
  and log the downgrade at `warn` (see contracts/fr-007-fallback-guard.md). Thread an
  optional `logger?` into `EvaluateCiReadinessParams` if not already available for the
  warn. `pending`/`not-passed` and all `check-runs`-sourced verdicts returned unchanged.
- [X] T005 [P] [US4] FR-007 docs: add a documentation comment at the `actions/runs`
  fallback readout site in
  `packages/workflow-engine/src/actions/github/client/gh-cli.ts` (~lines 1709-1739)
  noting it only enumerates GitHub-Actions workflow runs and is blind to third-party
  required checks, pointing at the `ci-merge-readiness.ts` fail-closed guard. Add the
  operator-facing note (checks:read-lacking cluster fails closed; granting `checks:read`
  restores full visibility) per FR-007 second clause.

## Phase 3: Core — P0 red-CI pause (US1 + US2)
<!-- Phase boundary: complete Phase 2 first (FR-006 not-passed classification feeds this path). T006 must precede T007/T008 (shared helper). -->

- [X] T006 [US1] Extract private `pauseForCiReadiness({ phase, reason, ...ctx })` in
  `packages/orchestrator/src/worker/phase-loop.ts` from the existing inline `timeout`
  branch (~lines 1289-1326). The helper performs, in order: emit `job:paused` with
  `gateLabel: 'waiting-for:ci'`; `await labelManager.onGateHit(phase, 'waiting-for:ci')`
  (adds `waiting-for:ci` + `agent:paused`, removes `phase:<phase>`; **MUST NOT** call
  `onPhaseComplete`); best-effort reason comment via
  `context.github.addIssueComment(...)` in try/catch (FR-004, warn on failure, never
  alter outcome); set `result.gateHit`, record `completedAt`; update stage comment;
  `return { results, completed: false, lastPhase: phase, gateHit: true }`. Re-point the
  existing `timeout` branch to call it with the timeout reason string (behavior-identical).
- [X] T007 [US1] FR-001/FR-002/FR-003: add the `not-passed` branch in the CI
  merge-readiness block of `phase-loop.ts`. When `waitForCiGreen` returns
  `{ kind: 'not-passed' }`, call `pauseForCiReadiness` with the red-CI reason and
  `return` early (before the gate loop and the step-6b `onPhaseComplete` fall-through).
  Never set `ciMergeVerdict` to a value that lets `on-ci-green` fire; never grant
  `completed:validate` (see contracts/ci-pause-behavior.md INV-1/INV-2/INV-3).
- [X] T008 [US2] FR-005: add the missing-head-SHA fast-fail **before** `waitForCiGreen`
  in the same block. Classify the head SHA unusable when `getCurrentCommitSha()` throws,
  yields a falsy value, or yields the literal `'unknown'` sentinel; on unusable, call
  `pauseForCiReadiness` with the SHA-resolution-failure reason and `return` — so
  `waitForCiGreen`/`getCiRunsForSha` (and `commits/unknown/check-runs`) are never invoked
  (contracts/ci-pause-behavior.md "Ordering guarantees").

## Phase 4: Tests (FR-009 + SC coverage)
<!-- Phase boundary: complete Phases 2-3 first. T009/T010/T011 touch different files → all [P]. -->

- [X] T009 [P] [US3] Extend `ci-verdict.test.ts` (workflow-engine) — SC-005:
  `startup_failure` → `not-passed`; `stale` → `not-passed`; `success + startup_failure`
  → `not-passed` (failure precedence); `skipped`/`neutral` still ignored → `pending`;
  existing `green`/`pending` rows unchanged.
- [X] T010 [P] [US4] Extend
  `packages/orchestrator/src/worker/__tests__/ci-merge-readiness.test.ts` —
  FR-007: `source === 'actions-runs'` + runs aggregating to `green` → returns
  `not-passed`; `source === 'check-runs'` + `green` → stays `green`;
  `actions-runs` + `pending`/`not-passed` → unchanged.
- [X] T011 [P] [US1] Extend
  `packages/orchestrator/src/worker/__tests__/phase-loop.ci-merge-gate.test.ts`:
  - SC-001/SC-003/FR-009: `validate` success + `not-passed` verdict →
    `{ completed: false, gateHit: true }`, issue labels contain `waiting-for:ci` +
    `agent:paused` and NOT `completed:validate`, `addIssueComment` attempted.
  - SC-002: no `onWorkflowComplete` call and no second `markReadyForReview` on the red
    path.
  - SC-004: `getCurrentCommitSha` throws → fast-fail pause with **no** `getCiRunsForSha`
    call (well under `ciWaitTimeoutMs`).
  - SC-006: existing `ciMergeGateEnabled=false` tests remain green (flag-off
    byte-identical — no new assertions, confirm unchanged).

## Phase 5: Verification

- [X] T012 Run the affected suites and typecheck:
  `pnpm --filter @generacy-ai/workflow-engine test` (ci-verdict),
  `pnpm --filter @generacy-ai/orchestrator test` (ci-merge-readiness +
  phase-loop.ci-merge-gate), plus `pnpm -w typecheck`. Confirm the new `not-passed`,
  missing-SHA, and FR-006/FR-007 cases pass and no existing case regressed.
- [X] T013 Confirm the changeset from T001 is a newly-added file in the PR diff
  (`git status .changeset/`) and lists both `@generacy-ai/orchestrator` and
  `@generacy-ai/workflow-engine` — the changeset-bot gate greps `--diff-filter=A`.

## Dependencies & Execution Order

**Sequential backbone**:
- T001 (changeset) can be done anytime; keep it in the PR.
- Phase 2 (T002-T005) → all parallel, independent files.
- T003 (FR-006 failing set) should land before T007's `not-passed` branch is meaningful
  end-to-end, but T007's code does not import it — logical, not compile, dependency.
- **T006 (extract `pauseForCiReadiness`) blocks T007 and T008** (they call the helper).
- T007 and T008 both edit the same block in `phase-loop.ts` → **not [P]**, do them
  sequentially after T006.
- Phase 4 tests (T009/T010/T011) depend on their respective source changes:
  T009←T002/T003, T010←T004, T011←T006/T007/T008. T009/T010/T011 touch different test
  files → parallel with each other.
- Phase 5 (T012/T013) last.

**Parallel opportunities**:
- T002, T003, T004, T005 (Phase 2) — different files.
- T009, T010, T011 (Phase 4) — different test files, once their sources land.

**Playbook coupling**: none — no `packages/claude-plugin-cockpit/commands/*.md` file is
edited by this issue, so no `playbook-verification.test.ts` re-pin task is required.

---

*Generated by speckit*
