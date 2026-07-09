# Tasks: `cockpit resume <issue-ref>` — re-arm a failed phase

**Input**: Design documents from `/specs/891-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/resume-cli.md, contracts/gate-vocabulary-api.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1/US2/US3/US4)

## Phase 1: Setup — Cross-package export prerequisite

<!-- Blocker for gate-vocabulary import: verify GATE_MAPPING is reachable from generacy package. -->

- [X] T001 Verify `GATE_MAPPING` and `WORKFLOW_GATE_MAPPING` are exported from `@generacy-ai/orchestrator` public entry (`packages/orchestrator/src/index.ts`). If not, add the exports per plan.md "Cross-Package Import Note". Also confirm `PHASE_SEQUENCE` / `getPhaseSequence` and the `WorkflowPhase` type are exported (from `packages/orchestrator/src/worker/types.ts`). No behavior change — export-only.

## Phase 2: Gate-inversion helper (foundational — blocks everything else)

- [X] T002 [US1] Extend `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` with new exports: `PrecedingGate` interface, `ResolvePrecedingGateResult` discriminated union, and `resolvePrecedingGate(phase, workflowName?)` function. Implement the deterministic selection algorithm from plan.md §Implementation Sequence step 1 (build effective mapping → filter by `resumeFrom === phase` → cross-phase preferred over self-loop → nearest predecessor in `PHASE_SEQUENCE`). Cache inverted `GATE_MAPPING` at module load; apply overlay per call. Match the API contract at `contracts/gate-vocabulary-api.md`.

- [X] T003 [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/gate-vocabulary.test.ts` with a new `describe('resolvePrecedingGate truth table', ...)` block. Assert every row of the truth-table in `contracts/gate-vocabulary-api.md`: `validate→implementation-review`, `implement→tasks-review`, `tasks→plan-review`, `plan→no-preceding-gate`, `clarify→spec-review` (documented tie-break), `specify→no-preceding-gate`, plus `resolvePrecedingGate('tasks', 'speckit-epic')` cross-check. Test MUST fail deterministically if `GATE_MAPPING` upstream changes flip any row.

## Phase 3: Tests First (TDD) — Unit + regression suites for `resume`

<!-- Phase boundary: T002 (helper) must be in place before test files can import it. Tests written FIRST, then implementation makes them pass. -->

- [X] T004 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/resume.test.ts` — skeleton mirroring `advance.test.ts` layout: deps-injection stub (`runner`, `gh`, `stdout`, `stderr`, `loadConfig`, `env`, `now`), fixture builder for label sets, `CockpitExit` capture helper. Import `runResume` and `resumeCommand` (which will be created in Phase 4 — tests will fail until then).

- [X] T005 [US1] In `resume.test.ts`, add FR-008(a) happy-path suite: one test per failed phase suffix with a valid preceding gate — `failed:validate`, `failed:implement`, `failed:tasks`, `failed:clarify`. Each asserts: (a) `gh.addLabels(nwo, n, [waiting-for:<G>, completed:<G>, 'agent:paused'])` called first, (b) `gh.removeLabels(nwo, n, [failed:<phase>, ...])` called second, (c) exit code 0, (d) stdout log line matches the format in `contracts/resume-cli.md`.

- [X] T006 [US3] In `resume.test.ts`, add FR-008(b) no-op suite: label set with no `failed:*` label → zero `gh.addLabels` / `gh.removeLabels` calls, exit 0, stdout matches `issue <nwo>#<n> is not in a failed state (no failed:<phase> label); nothing to re-arm`.

- [X] T007 [US3] In `resume.test.ts`, add FR-008(c) refusal suite — one test per FR-004 branch: (i) two `failed:*` labels present, (ii) `failed:<unknown-phase>`, (iii) `failed:specify` and `failed:plan` (no preceding gate; evidence line names `process:<workflow>` re-queue), (iv) `failed:validate` with `waiting-for:<other-gate>` present. Each asserts exit code 3, stderr evidence line matches the copy in `contracts/resume-cli.md#Refusal branches`, and zero mutating `gh` calls.

- [X] T008 [US1] In `resume.test.ts`, add FR-008(d) issue-ref grammar wiring suite — mirror `advance.test.ts` "bare-number ref resolution (#850)" block: (a) bare-number resolves via git origin, (b) unresolvable origin → `CockpitExit(2)` with matching copy, (c) `owner/repo#N` form → no `git remote get-url origin` runner call. Also add a negative assertion that `resume.ts` never imports `parseIssueRef` directly (grep-style import assertion or ensure `resolveIssueContext` is on the call path).

- [X] T009 [US1] In `resume.test.ts`, add FR-002 ordering invariant test: inspect `gh` mock's call order — assert `addLabels` invocation index < `removeLabels` invocation index. Add Q3/Q5 defensive-removal tests: (a) both `agent:error` and `phase:<phase>` present → three-item remove list, (b) both absent → single-item remove list `[failed:<phase>]`; log line reports only actual mutations. Add Q5 preservation test: `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement` on a `failed:validate` fixture — assert none of these appear in any `removeLabels` call.

- [X] T010 [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/resume.regression.test.ts` — FR-009 end-to-end poll-path handoff. Fixture: `failed:validate` speckit-feature issue with realistic prior state `{failed:validate, agent:error, phase:validate, completed:specify, completed:clarify, completed:plan, completed:tasks, completed:implement, workflow:speckit-feature}`. Run `runResume` against stubbed `gh` that records mutations. Apply the recorded mutations to the fixture set to produce the post-resume label set. Import `parseLabelEvent` from `packages/orchestrator/src/services/label-monitor-service.ts` (or its exported detection predicate) and assert a `LabelEvent` of `type: 'resume'` is produced against the post-resume set + newly-added `completed:implementation-review`. Import `PhaseResolver` and assert `resolveStartPhase(postResumeLabels, 'continue', 'speckit-feature')` returns `'validate'`. Assert prior-phase `completed:*` chain is present in the post-resume set.

## Phase 4: Core implementation — `resume.ts`

<!-- Phase boundary: Tests from Phase 3 exist and are failing; implementation makes them pass. -->

- [X] T011 [US1] Create `packages/generacy/src/cli/commands/cockpit/resume.ts` — `resumeCommand()` Commander subcommand + `runResume(deps)` core. Shape mirrors `advance.ts`: deps-injection surface (`runner`, `gh`, `loadConfig`, `env`, `now`, `stdout`, `stderr`), single `[issue]` argument, optional `--workflow <name>` flag, `CockpitExit` for controlled exits (codes `0` / `1` / `2` / `3` per `contracts/resume-cli.md#Exit Codes`). Route issue-ref via `resolveIssueContext` (FR-005). No `parseIssueRef` direct call. No `--force` flag.

- [X] T012 [US1/US3] In `resume.ts`, implement the `classify(labels, workflowName)` internal function returning `ResumeClassification` (per `data-model.md#ResumeClassification`). Branches: `no-op` (no `failed:*`), `refuse-multiple-failed`, `refuse-unknown-phase`, `refuse-no-preceding-gate` (calls `resolvePrecedingGate` from T002; refusal message points at `process:<workflow>`), `refuse-conflicting-waiting` (existing `waiting-for:<other>` ≠ derived gate), `happy-path` (with `labelsToAdd`, `labelsToRemove` — defensive removes for `agent:error`, `phase:<phase>` only if present). Resolve `workflowName` from `workflow:<name>` label (fall back to `speckit-feature`) — mirror `label-monitor-service.ts:resolveWorkflowFromLabels`.

- [X] T013 [US1] In `resume.ts` `runResume`, wire the mutation sequence per plan.md §Implementation Sequence step 3: (1) `gh.fetchIssueLabels(nwo, n)`, (2) classify, (3) on happy-path: `gh.addLabels(nwo, n, [waitingLabel, completedLabel, 'agent:paused'])` FIRST, then `gh.removeLabels(nwo, n, [failedLabel, ...conditionalRemovals])` SECOND — additions before removals per spec Assumption §7. Emit the single-line log per FR-010 / `contracts/resume-cli.md#Log Line Format` — defensive removes that were no-ops MUST NOT appear in the log line.

- [X] T014 [US2] Register `resumeCommand()` in `packages/generacy/src/cli/commands/cockpit/index.ts` — add `import { resumeCommand } from './resume.js';` and `command.addCommand(resumeCommand());` next to the existing six subcommands. Update the file-header comment listing the verbs to include `resume`.

## Phase 5: Documentation

<!-- Phase boundary: verb is now callable; documentation reflects final surface. -->

- [X] T015 [US4] Add a new `### cockpit resume` subsection to `packages/generacy/README.md` under the existing CLI Commands / cockpit block. Fields per FR-007: purpose (one sentence), accepted ref forms (bare number / `owner/repo#N` / URL), exit codes `0`/`1`/`2`/`3` with meanings, labels added (`waiting-for:<preceding-gate>`, `completed:<preceding-gate>`, `agent:paused`), labels removed (`failed:<phase>` always; `agent:error`, `phase:<phase>` defensively), idempotency semantics (non-failed → no-op), refusal semantics (four branches, non-zero exit with evidence), example (`generacy cockpit resume generacy-ai/generacy#42` after `failed:validate`). Use `contracts/resume-cli.md` as the source of copy.

## Phase 6: Polish & Validation

- [X] T016 [P] [US1] Run `pnpm --filter @generacy-ai/generacy test` — confirm `resume.test.ts`, `resume.regression.test.ts`, and the extended `gate-vocabulary.test.ts` all pass. Confirm no regression in `advance.test.ts` or other cockpit tests.

- [X] T017 [P] [US1] Run `pnpm --filter @generacy-ai/generacy typecheck` and `pnpm --filter @generacy-ai/generacy build` — confirm no TypeScript errors from the new cross-package import of `GATE_MAPPING` / `WORKFLOW_GATE_MAPPING` / `PHASE_SEQUENCE`.

- [X] T018 [P] [US1] Run `pnpm --filter @generacy-ai/generacy lint` — confirm the `no-restricted-imports` rule from #850 covers `resume.ts` (grep the ESLint config or extend the file-glob in `.eslintrc.json` if the `cockpit/**/*.ts` pattern excludes new files). Assert `resume.ts` contains zero direct `parseIssueRef` imports (SC-007).

- [X] T019 [P] [US1] Manual smoke test: `pnpm --filter @generacy-ai/generacy build && node packages/generacy/dist/cli.js cockpit resume --help` — confirm the verb is registered in the group's help output (SC-001). Then `node packages/generacy/dist/cli.js cockpit --help` — confirm `resume` appears in the subcommand list.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (verify orchestrator exports) → T002 (helper import).
- T002 (helper implementation) → T003 (helper tests) → T004..T010 (all `resume` tests import the helper).
- T004 (test skeleton) → T005..T009 (fill in test cases in the same file).
- T010 (regression test) requires T002 (for its stubbed classifier trace).
- T004..T010 (failing tests) → T011..T013 (implementation makes them pass).
- T011 (subcommand exists) → T014 (registration).
- T014 (registration) → T015 (README reflects registered verb).
- T011..T014 (all impl) → T016..T019 (polish).

**Parallel opportunities**:
- T003 and T004..T010 can start once T002 lands — different test files (`gate-vocabulary.test.ts` vs `resume.test.ts` vs `resume.regression.test.ts`).
- Within Phase 3, T004 must land first (skeleton in `resume.test.ts`); T005..T009 all extend the same file and are sequential edits. T010 (`resume.regression.test.ts`) is a different file — parallel to T005..T009.
- T016..T019 (polish tasks) are all independent read-only checks over the built package — fully parallel.

**Critical path**: T001 → T002 → (T004 → T005..T009 ‖ T010 ‖ T003) → T011 → T012 → T013 → T014 → T015 → (T016 ‖ T017 ‖ T018 ‖ T019).

**Notes**:
- No changes to `label-monitor-service.ts`, `phase-resolver.ts`, `label-manager.ts`, or the label protocol — regression test (T010) verifies the label surface satisfies the existing detector/resolver.
- Prefer additive-only cross-package changes — T001 either confirms exports exist or adds them without behavior change.
- Tests-first is intentional: TDD ordering catches the "verb registered but not routed" and "classifier drift" bugs early.
