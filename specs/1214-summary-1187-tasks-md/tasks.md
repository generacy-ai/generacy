# Tasks: Manual-task awareness in the #1187 tasks.md safety net

**Input**: Design documents from `/specs/1214-summary-1187-tasks-md/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/manual-classification.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

All work is in `packages/orchestrator/src/worker/`. No new dependencies, no new label
vocabulary (SC-008), no feature flag, no persisted state (FR-013).

## Phase 1: Classification core (`tasks-md-fallback.ts`)

- [X] T001 [US2] Add the two-tier manual detectors to `packages/orchestrator/src/worker/tasks-md-fallback.ts`:
  module-level `const MANUAL_MARKER = /\[manual\]/i` (Tier 1) and
  `const MANUAL_KEYWORDS = /\b(?:manual|manually|hand-test)\b/i` (Tier 2), plus a pure
  per-line helper that extracts the **task text** and returns whether the line classifies
  manual. Task text = substring after the `CHECKBOX_LINE` capture for checkbox grammar, or
  after the heading marker + `T\d+` ID + optional `[DONE]` token for heading grammar.
  Tier 2 runs only when Tier 1 does not match, and only against the **first 4
  whitespace-delimited words** of the task text (contracts §1, plan D-2).
  Document that the marker is position-lenient (#2714 evidence) while the keyword window is
  strict (`HEADING_DONE`-style discipline) — mirroring the existing regex doc comments at
  `tasks-md-fallback.ts:23-39`.

- [X] T002 [US2] Widen `countTasks` (`tasks-md-fallback.ts:55-84`) to return
  `{ unchecked, checked, total, manual }`, where `manual` counts **unchecked** tasks that
  classify manual. Call the T001 helper only on the unchecked branch of each grammar —
  checked lines are simply checked, so a heading carrying both `[DONE]` and `[manual]` counts
  checked, full stop (FR-005/006, contracts §1). `unchecked` / `checked` / `total` semantics
  and the checkbox-first / heading-second line dispatch must be byte-identical (SC-005).

- [X] T003 [US2] Widen `TasksMdEvaluation` and `evaluateTasksMd` (`tasks-md-fallback.ts:18-21`,
  `:125-129`) per data-model.md: add the `manual-only` variant
  (`{ kind: 'manual-only'; unchecked; manual; checked; total }`) and add `automatable` +
  `manual` to the `incomplete` variant. Derive `automatable = unchecked - manual` and classify:
  `unchecked === 0` → `complete`; `unchecked > 0 && automatable === 0` → `manual-only`;
  `automatable > 0` → `incomplete`. `complete` and `unreadable` variants and all the
  spec-dir-resolution / read-failure paths stay byte-identical (FR-007/011). Extend the
  type's doc comment with the `manual-only` case.

## Phase 2: Classification tests (`__tests__/tasks-md-fallback.test.ts`)

- [X] T004 [US2] Add a marker-tier and keyword-tier classification matrix to
  `packages/orchestrator/src/worker/__tests__/tasks-md-fallback.test.ts`, pinning the
  data-model.md truth table: marker anywhere in the checkbox line (leading and trailing),
  marker in heading grammar, `[DONE]` + `[manual]` co-presence counting as checked, case
  insensitivity; keyword positives (`Manually verify …` word 1, `Hand-test the …` word 1,
  `Verify manually that …` word 2), keyword negatives (`rewrite the entire user manual
  section` — word 5+, `add manuals directory` — whole-word failure). Explicitly pin the
  **accepted residual false positive** `- [ ] T011 update the user manual` (keyword lands at
  word 4, inside the window → classifies manual) with a comment naming it as the documented
  Q2=B trade-off, so a future reader does not "fix" it silently.

- [X] T005 [US2] In the same file, add counting-invariance and variant-classification tests:
  `manual` never shifts `unchecked` / `checked` / `total` (re-assert against a fixture mixing
  manual and non-manual lines in both grammars, SC-005); `manual-only` vs `incomplete`
  (with correct `automatable` / `manual` splits) vs `complete` vs `unreadable`. Add the two
  field fixtures required by SC-009: the **#2723** remainder (`T028` browser-verify +
  `T029` deploy checklist, both "Manually verify …" phrasing → keyword tier → `manual-only`)
  and the **#2714** remainder (single `T030 [manual] Browser verification …` → marker tier →
  `manual-only`). Leave the existing `countTasks` grammar matrices at `:22` and `:75`
  unmodified — they are the SC-005 regression pin.

## Phase 3: Safety-net pause path (`phase-loop.ts`)
<!-- Phase boundary: Phase 1 must land first — the pause path consumes the `manual-only` variant. -->

- [X] T006 [US1] Add a private label-read helper to
  `packages/orchestrator/src/worker/phase-loop.ts` that calls
  `context.github.getIssueLabels(owner, repo, issueNumber)` (same call shape as `:2064`)
  inside try/catch and returns a tri-state — label present / absent / read-failed. On
  read failure emit `this.logger.warn({ phase, issueNumber, error }, …)` noting the
  fallback to tasks.md classification (FR-002, Q4=A: fail-open to classification, never
  fail-closed and never blind re-entry).

- [X] T007 [US1] [US3] Add a private `pauseForManualValidation` method to `phase-loop.ts`
  implementing the contracts §3 sequence exactly once, so both the safety-net block and the
  no-progress guard share it: (1) `prManager.commitPushAndEnsurePr(phase, { message:
  'wip(speckit): pause for manual validation for #<issue>' })`; (2) on `pushRefused` →
  `logger.warn` + `return { results, completed: false, lastPhase: phase, gateHit: false }`
  (#1051 abort, no labels applied); (3) `if (outcome.prUrl) context.prUrl = outcome.prUrl`;
  (4) `await labelManager.onPhaseComplete('implement')` (grants `completed:implement`, Q1=A);
  (5) `await labelManager.onGateHit('implement', 'waiting-for:manual-validation')`;
  (6) `return { results, completed: false, lastPhase: phase, gateHit: true }`. Never apply
  `failed:implement`, `failed:implement-repeated`, or `agent:error`, and never post a failure
  alert (FR-004). Structure mirrors the #1211 dependency-block branch at `:979-1062`.

- [X] T008 [US1] [US2] [US4] Rewire the safety-net block (`phase-loop.ts:914-952`) to the
  contracts §2 decision table, keeping the outer guard
  `phase === 'implement' && result.success && result.implementResult === undefined`
  untouched so the sentinel path stays byte-identical (SC-007):
  label present → T007 pause, no synthesis, and when the (still-run, for logging) evaluation
  reports `automatable > 0` also emit a structured divergence warn with
  `reason: 'manual-validation-label-present'` and `{ phase, issueNumber, unchecked,
  automatable, manual, checked, total }`, field-consistent with the existing logs at
  `:929-949`; label absent (or read-failed) + `manual-only` → T007 pause; label absent +
  `incomplete` → synthesize `implementResult` with `tasks_remaining: evalResult.automatable`
  (**not** `unchecked` — FR-008, so the no-progress guard compares automatable progress only),
  `tasks_completed: evalResult.checked`, `tasks_total: evalResult.total`, and log the existing
  re-entry message extended with the automatable/manual split; `complete` / `unreadable` →
  advance with the existing log lines unchanged (FR-011).

- [X] T009 [US1] Update the #1133 comment at `phase-loop.ts:1923-1932`: the sentence claiming
  on-ci-green is "the one gate where `completed:<phase>` is granted at pause" is now false —
  `waiting-for:manual-validation` is the second such gate (#1214). Note that the ordering is
  safe against the #958 assumption at `label-manager.ts:287-292` for the same reason as the
  ci-green path: `onPhaseComplete` has already removed `phase:implement`, so `onGateHit`'s
  `removeLabels` is a no-op. Comment-only change; do not touch the `on-ci-green` code path.

## Phase 4: No-progress guard pause (`phase-loop.ts`)
<!-- Phase boundary: needs T006 + T007. -->

- [X] T010 [US3] In the no-progress guard branch (`phase-loop.ts:1071-1100`), before
  `result.success = false` and before `escalateAndAlert`, re-run the T006 label check and the
  evaluator. If the remainder is human-gated (label present **or** evaluation is
  `manual-only`) → log the reason and take the T007 pause instead of the failure path
  (FR-009). This covers the sentinel-present case the safety-net block never sees (the agent
  emitted `SPECKIT_IMPLEMENT_PARTIAL` over a purely manual remainder). Every other guard
  firing — unchanged remainder containing automatable work — must stay byte-identical:
  same `result.error` shape, same `buildErrorEvidence('implement (no-progress guard)', …)`,
  same `updateStageComment({ status: 'error', … })`, same escalation, same return (FR-010).

## Phase 5: Phase-loop tests (`__tests__/phase-loop.manual-validation.test.ts`)
<!-- Phase boundary: needs Phases 3-4. -->

- [ ] T011 [US1] Create
  `packages/orchestrator/src/worker/__tests__/phase-loop.manual-validation.test.ts`,
  following the harness/mock conventions of the sibling
  `__tests__/phase-loop.dependency-block.test.ts` (injected `deps.evaluateTasksMd`, stub
  `labelManager`, `prManager`, `context.github.getIssueLabels`, `stageCommentManager`).
  First cases: `waiting-for:manual-validation` present + unchecked tasks → no synthesized
  `implementResult`, no implement re-entry, one `commitPushAndEnsurePr` call, returns
  `{ completed: false, gateHit: true }` (SC-001); and the applied label set contains neither
  `failed:implement` nor `failed:implement-repeated` and no failure alert was posted (SC-003,
  FR-004).

- [ ] T012 [US2] Add `manual-only` pause coverage to the same file: label **absent** +
  evaluation `manual-only` (the #2714 shape) → pause, not re-entry (SC-002); assert the
  **call order** `onPhaseComplete('implement')` before
  `onGateHit('implement', 'waiting-for:manual-validation')` (Q1=A — this ordering is what
  makes `resumeFrom: 'validate'` resolvable); and `pushRefused` from
  `commitPushAndEnsurePr` → returns `gateHit: false` with **zero** label calls (#1051 abort).

- [ ] T013 [US2] [US4] Add precedence and mixed-remainder coverage: mixed remainder
  (automatable > 0, no label) → still re-enters and the synthesized `tasks_remaining` equals
  the **automatable** count, not `unchecked` (SC-006); label present + `automatable > 0` →
  pause **and** a divergence warn carrying `reason: 'manual-validation-label-present'`;
  `getIssueLabels` rejecting → warn emitted and behavior follows the label-absent rows
  (`manual-only` → pause, `incomplete` → re-entry); purely automatable remainder with no
  label → re-entry identical to #1187 (SC-007 companion, US4).

- [ ] T014 [US3] Add guard coverage to the same file: unchanged remainder that is human-gated
  (label present, and separately `manual-only`) → pause, no `failed:implement`, stage comment
  **not** written with `status: 'error'`, `escalateAndAlert` not called (FR-009); unchanged
  remainder with automatable work → guard fires exactly as today (`result.success === false`,
  error message/output text unchanged, escalation called, `gateHit: false`) (FR-010).

- [ ] T015 [US4] Add a sentinel-path pin: an implement result **with**
  `SPECKIT_IMPLEMENT_PARTIAL`-derived `implementResult` never reaches the safety-net block —
  `deps.evaluateTasksMd` is not called and `getIssueLabels` is not consulted for the manual
  check (SC-007). Then confirm the pre-existing `__tests__/phase-loop.test.ts` safety-net
  cases still pass **unmodified**; if any needed editing, that is a signal T008 changed
  behavior it should not have — fix the source, not the test.

## Phase 6: Verification & release
<!-- Phase boundary: all code and tests must land first. -->

- [ ] T016 Add `.changeset/1214-manual-task-safety-net.md` — `@generacy-ai/orchestrator`
  **patch** (`workflow:speckit-bugfix`; internal worker fix, no new public exports, no new
  label vocabulary). Required: this diff touches non-test files under
  `packages/orchestrator/src/`, so the changeset-bot CI gate fails without a **newly added**
  changeset file (see CLAUDE.md § Changesets).

- [ ] T017 Run the gates and confirm the non-change invariants:
  `pnpm --filter @generacy-ai/orchestrator test -- tasks-md-fallback`,
  `pnpm --filter @generacy-ai/orchestrator test -- phase-loop`,
  `pnpm type-check`, then the full orchestrator suite. Verify via `git diff --stat` that
  the branch touches **no** `label-definitions.ts` (SC-008) and no
  `phase-resolver.ts` / cockpit / label-monitor files, and that
  `packages/orchestrator/src/worker/types.ts` `ImplementPartialResult` is unchanged.

## Dependencies & Execution Order

**Sequential phases**:
Phase 1 → Phase 3 → Phase 4 → Phase 5 → Phase 6. Phase 3 consumes the `manual-only`
variant added in T003, Phase 4 reuses the T006/T007 helpers, Phase 5 exercises both, and
Phase 6 verifies the whole diff.

**Within-phase ordering**:
- T001 → T002 → T003 (same file, each builds on the previous).
- T004 → T005 (same file).
- T006 → T007 → T008 → T009 (T009 is comment-only and could land any time after T007, but
  keep it in the same commit as the pause path so the comment and the second
  completed-at-pause gate ship together).
- T011 → T012 → T013 → T014 → T015 (same file).

**Parallel opportunities**:
Phase 2 (T004-T005) is independent of Phases 3-4 once Phase 1 has landed — the classifier
tests touch only `tasks-md-fallback.test.ts` while the pause path touches only
`phase-loop.ts`. No `[P]` markers are set within phases because every task in a phase edits
the same file.

**Playbook coupling**: none. No `packages/claude-plugin-cockpit/commands/*.md` path appears in
spec.md, plan.md, or the issue body, so no `playbook-verification.test.ts` re-pin task is
required.

**Manual tasks**: none. Every task here is verifiable headlessly via Vitest and `git diff` —
deliberately so, since this issue is precisely about the engine mishandling manual-only
remainders.
