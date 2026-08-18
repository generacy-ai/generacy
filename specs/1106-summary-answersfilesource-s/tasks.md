# Tasks: Case-insensitive gateKey/epicRef repo-scope filter

**Input**: Design documents from `/specs/1106-summary-answersfilesource-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [US1] Make the repo-scope filter case-insensitive in `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts` (`processLine`, lines 646–655). Replace the two raw comparisons at `:648-649` with case-folded ones: `gateScope.owner.toLowerCase() !== this.epicScope.owner.toLowerCase() || gateScope.repo.toLowerCase() !== this.epicScope.repo.toLowerCase()`. Leave the `number` field, the `cross-epic drop` log line (`:651-653`, must keep printing observed casing), and `parseIssueRefFromGateKey`/`parseEpicRef` (raw casing) untouched. (FR-001, FR-002, FR-005, FR-006)
- [X] T002 [US1] Update the comment block at `answers-file-source.ts:636-644` with one sentence: the owner/repo comparison is case-insensitive per GitHub semantics (documents WHY the fold exists so a future refactor cannot silently undo it). (Plan §Design)

## Phase 2: Regression Tests

- [X] T003 [US3] Add case-divergence and foreign-repo regression cases to `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.unit.test.ts`, alongside the existing foreign-owner drop case (`:437`) and child-issue-delivered case (`:465`), copying that harness pattern (`fs` façade, `useFsWatch: false`):
  1. Forward divergence: bind `epicRef: 'painworth/x#1'`, feed `Painworth/x#1:clarification:…` → exactly one `gate-answer` event, no `cross-epic drop` log. (SC-002)
  2. Reverse divergence: bind `epicRef: 'Painworth/x#1'`, feed `painworth/x#1:…` → emitted. (SC-002)
  3. Repo-name case divergence: bind `owner/Repo#1`, feed `owner/repo#1:…` → emitted (proves the fold covers the repo component).
  4. Genuine foreign repo unchanged: bind `painworth/x#1`, feed `painworth/y#1:…` → still dropped + logged. (SC-003)
  5. Foreign owner unchanged: bind `painworth/x#1`, feed `other/x#1:…` → dropped. (SC-003)
  Cases 1–2 are the guard that fails if the non-folded `!==` is restored. (FR-004, US3)
- [X] T004 [P] [US3] (Optional) Add a small multi-line mixed-case fixture to `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.replay.test.ts` replaying the observed same-repo mixed-case `answers.ndjson` pattern → 0 same-repo answers dropped for casing reasons. Closer fidelity to the live file for SC-001 (cases 1–3 already satisfy SC-001). (SC-001)

## Phase 3: Changeset & Follow-up

- [X] T005 [P] [US1] Add newly-created changeset `.changeset/1106-case-insensitive-repo-scope.md` — `@generacy-ai/generacy` **patch** (defect fix per `workflow:speckit-bugfix`; no new public exports). Use the prose from quickstart.md. Must be a `--diff-filter=A` new file in the PR diff (CI gate). (Plan §Changeset)
- [X] T006 [P] [US1] File a separate follow-up GitHub issue for removing the repo-scope filter entirely / adding cross-repo `epicRef` support (clarification Q1=C option B). Note the motivation: the finetooth cluster's single `answers.ndjson` carries gates from ≥4 distinct epics, so filter removal introduces real foreign-epic no-op wake-ups. Filing is in scope; implementing is not. (FR-008)

## Phase 4: Verification

- [X] T007 [US3] Build and run the doorbell answers-file suites: `pnpm --filter @generacy-ai/generacy build && pnpm --filter @generacy-ai/generacy test answers-file-source`. Confirm existing suites pass unmodified (SC-004), new case-divergence cases pass (SC-002), and the genuine-foreign-repo case still drops + logs (SC-003).

## Dependencies & Execution Order

- **T001 → T002**: same file; do the code change then the comment (or together in one edit).
- **T003 depends on T001**: tests assert the folded behavior; write the fix first.
- **T004, T005, T006** are independent of each other and of the test file (`[P]`); T004/T005 can be written any time after T001, T006 has no code dependency.
- **T007 is last**: requires T001–T003 landed to pass.

**Parallel opportunities**: T004 (replay test file), T005 (changeset file), and T006 (GitHub issue) touch disjoint targets and can proceed concurrently once T001 is done.

**Playbook coupling**: none. No `packages/claude-plugin-cockpit/commands/*.md` file is edited by this issue, so no `playbook-verification.test.ts` re-pin task is required.
