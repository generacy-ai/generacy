# Tasks: Flag-matrix guardrails for the review/remediate epic

**Input**: Design documents from `/specs/1165-severity-major-p2-feature/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Overview

Four independent corners of the review/remediate flag matrix (#1120), each with a
decided outcome (D1–D4 = A). Two require production code changes (Corner 1 →
`phase-loop.ts`; Corner 4 → `types.ts`); one is doc-only (Corner 2); one is
test-only (Corner 3). Each corner is pinned by a test (SC-003). Both flags stay
default `false`.

Production changes are confined to `@generacy-ai/orchestrator` worker internals —
no cross-package public API change (plan Technical Context).

---

## Phase 1: Corner 4 — `getPhaseSequence` fallback gating (FR-007)

<!-- Smallest, self-contained production change; nothing depends on it. Do first. -->

- [ ] T001 [US4] In `packages/orchestrator/src/worker/types.ts` `getPhaseSequence(workflowName, reviewPhaseEnabled = false)`:
  when `WORKFLOW_PHASE_SEQUENCES[workflowName] === undefined` (unknown/custom workflow),
  always return `PHASE_SEQUENCE` with `review` filtered out, regardless of `reviewPhaseEnabled`.
  Known workflows keep the existing flag-conditional behavior
  (`reviewPhaseEnabled ? known : known.filter(p => p !== 'review')`). Keep the
  function pure and side-effect-free. Ref: `contracts/get-phase-sequence.md`,
  `data-model.md` E1 truth table.

- [ ] T002 [US4] Add/extend `packages/orchestrator/src/worker/__tests__/get-phase-sequence.test.ts`
  asserting the truth table (FR-008): unknown workflow + `reviewPhaseEnabled=true` ⇒ excludes `review`;
  unknown + `false` ⇒ excludes `review`; `speckit-feature` + `true` ⇒ includes `review` (regression guard);
  `speckit-feature` + `false` ⇒ excludes `review` (regression guard); `speckit-epic` (any flag) ⇒ never
  includes `review`. Ref: `contracts/get-phase-sequence.md` Test assertions.

---

## Phase 2: Corner 1 — flag-OFF validate-fix fallback (FR-001, FR-002)

<!-- Largest change. Sequential within the phase (same file, shared helper). -->

- [ ] T003 [US1] In `packages/orchestrator/src/worker/phase-loop.ts` (`executeLoopInner`),
  factor the flag-ON `changes-required` review-artifact synthesis (currently inline at `:1038-1075`)
  into a shared private helper (one `critical` open `ReviewFinding` citing `effectiveValidateCommand`
  with fenced/bounded validate stdout+stderr, carrying `remediationCount` and `markedReadyByEngine`
  forward). Have the existing flag-ON block call the helper (no behavior change). Ref:
  `contracts/flag-off-validate-fix.md` step 2, `data-model.md` E2.

- [ ] T004 [US1] In `packages/orchestrator/src/worker/phase-loop.ts` (`executeLoopInner`),
  add the block-local `flagOffValidateFixAttempted: boolean` (init `false`) and insert the flag-OFF
  fallback branch **after** the flag-ON validate-fix block (`:971-1090`) and **before** the escalation
  fall-through (`:1092`). Guard: `phase === 'validate' && config.reviewPhaseEnabled !== true &&
  flagOffValidateFixAttempted === false && deps.remediateExecutor`. On fire: set the flag `true`;
  synthesize the artifact via the T003 helper; run `deps.remediateExecutor.execute(context)`; apply the
  seam's push-gate (`shouldPush = exitCode === 0 || timedOut`) with `commitPushAndEnsurePr('remediate')`
  (honoring a `pushRefused` abort) or revert-on-non-push via
  `context.github.discardWorkingTreeChanges(['.generacy'])` (abort loop if the revert throws); then `i--`
  and `continue`. Guard-fail falls through to the existing escalation unchanged. Ref:
  `contracts/flag-off-validate-fix.md` Guard/Steps/Invariants, `data-model.md` E3.

- [ ] T005 [US1] Add `packages/orchestrator/src/worker/__tests__/phase-loop.flag-off-validate-fix.test.ts`
  (FR-002): (a) flag OFF + validate fails once + remediate succeeds + validate re-run passes ⇒ loop
  completes, no `failed:validate`, exactly one `remediateExecutor.execute` call; (b) flag OFF + validate
  fails + remediate runs + validate fails again ⇒ exactly one `execute` call, then `failed:validate`;
  (c) flag OFF + `deps.remediateExecutor` undefined ⇒ escalates immediately (no attempt); (d) flag-ON
  path and non-validate phases unaffected (regression guard). Ref: `contracts/flag-off-validate-fix.md`
  Test assertions.

---

## Phase 3: Corner 3 — speckit-bugfix `on-ci-green` gate (FR-005, FR-006)

<!-- Test-only; no production change. Independent — can run parallel with Phase 4. -->

- [ ] T006 [P] [US3] Add `packages/orchestrator/src/worker/__tests__/config.bugfix-ci-gate.test.ts`
  (FR-006): parse `WorkerConfigSchema` with `ciMergeGateEnabled: false` and again with `true` (otherwise
  default config) and assert the speckit-bugfix `implementation-review` gate — `false` ⇒
  `{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' }`;
  `true` ⇒ `{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }`.
  Also assert other speckit-bugfix gates (clarification, merge-conflicts, remediation-limit) are
  unaffected by the flag (INV-3). No production change — pins the #1133 transform at
  `config.ts:229-247`. Ref: `contracts/bugfix-ci-gate.md`.

---

## Phase 4: Corner 2 — `blocked:stuck-feedback-loop` doc reconcile (FR-003, FR-004)

<!-- Doc edit + test-only behavior pin. Independent — can run parallel with Phase 3. -->

- [ ] T007 [P] [US2] Correct `docs/docs/guides/generacy/review-remediate-migration.md:140`: scope the
  "retired/replaced" claim to the **epic review/remediate path** and affirm that
  `blocked:stuck-feedback-loop` retains its bounded-stop role on the **flag-OFF PR-feedback legacy path**
  (the monitor skips all `blocked:*`). Must carry both load-bearing facts: (1)
  `waiting-for:remediation-limit` supersedes the label only on the epic path; (2) the label is still
  active/load-bearing on the flag-OFF PR-feedback path. Doc-only, outside `packages/*/src/` (no
  changeset). Ref: `contracts/stuck-loop-doc-reconcile.md` Doc change.

- [ ] T008 [P] [US2] Add/extend `packages/orchestrator/src/worker/__tests__/pr-feedback-stuck-loop.test.ts`
  (FR-003/FR-004): assert `blocked:stuck-feedback-loop` is still applied and bounds the loop on the
  legacy PR-feedback path (`pr-feedback-handler.ts:45`/`:632`, on `!cliSelfCommitted && (!success ||
  !hasChanges)`), so the #883 runaway stays bounded. No new behavior — pins the existing bounded-stop
  (SC-003). Ref: `contracts/stuck-loop-doc-reconcile.md` Test assertion.

---

## Phase 5: Changeset & Verification

<!-- Phase boundary: land all code/doc/test changes before finalizing. -->

- [ ] T009 [US1] Add `.changeset/1165-flag-matrix-guardrails.md` — `@generacy-ai/orchestrator` **patch**.
  Corner 1 (`phase-loop.ts` + `types.ts`) is the only non-test production change under
  `packages/*/src/`; no new public exports; `workflow:speckit-bugfix` → `patch` per the CLAUDE.md
  changeset gate. Corner 2's doc edit and the Corner 2/3 test-only additions are exempt. Ref: plan.md
  Changeset, `research.md` Changeset sizing.

- [ ] T010 [US4] Run the full four-corner suite and confirm green (SC-003/SC-004):
  `pnpm --filter @generacy-ai/orchestrator test -- phase-loop.flag-off-validate-fix get-phase-sequence
  config.bugfix-ci-gate pr-feedback-stuck-loop`, plus existing flag-OFF regression tests remain green
  (FR-009 byte-identical guard). Verify the changeset gate is satisfied. Ref: `quickstart.md` Run the
  tests.

---

## Dependencies & Execution Order

**Within phases**:
- Phase 1: T001 → T002 (test depends on the `types.ts` change).
- Phase 2: T003 → T004 → T005 (shared helper first, then the branch that calls it, then the test; all in
  `phase-loop.ts`, so sequential).
- Phase 3: T006 standalone (test-only).
- Phase 4: T007 (doc) and T008 (test) touch different files — independent.

**Across phases**:
- Phases 1, 2, 3, 4 are mutually independent (different files / concerns) and could be worked in any
  order. Recommended order is Phase 1 (smallest) → Phase 2 (largest) → Phases 3 & 4 (test/doc).
- Phase 5 (T009 changeset, T010 verification) is the final phase — it must follow the two production
  changes (T001, T004) and all tests.

**Parallel opportunities**:
- T006 [P] (Corner 3 test) and T007 [P] / T008 [P] (Corner 2 doc + test) can all run concurrently once
  the developer picks them up — no shared files with each other or with Phases 1/2.
- Phase 1 and Phase 2 touch different files (`types.ts` vs `phase-loop.ts`) and can be developed in
  parallel by separate agents if desired, but T010 gates on both.

## Notes

- No playbook `packages/claude-plugin-cockpit/commands/*.md` file is edited by this feature — no
  playbook-verification re-pin task is required.
- No `.specify/memory/constitution.md` exists — constitution check skipped.
- Both feature flags remain default `false`; this feature does not change default flag values.
