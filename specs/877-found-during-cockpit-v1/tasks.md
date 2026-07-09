# Tasks: `wizard-credentials.env` trailing newline fix

**Input**: Design documents from `/specs/877-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Implementation

- [ ] T001 [US1] Append `+ '\n'` to the non-empty return branch of `formatEnvFile()` in `packages/control-plane/src/services/wizard-env-writer.ts:85`. Empty-entries branch (line 84 `return '';`) unchanged per FR-002. No comment added — invariant is obvious.

## Phase 2: Regression Tests
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T002 [US1] Update the existing two-entry `formatEnvFile` assertion in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts:372` from `'KEY1=val1\nKEY2=val2'` to `'KEY1=val1\nKEY2=val2\n'` (FR-001). Leave the empty-array test at line 364 unchanged (FR-002).
- [ ] T003 [P] [US1] In `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`, add a new test that mocks `credentials.yaml` + backend with two credentials, calls `writeWizardEnvFile()` against a temp path, reads the file, and asserts `contents.endsWith('\n')` (FR-004).
- [ ] T004 [P] [US2] In `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`, add a new regression test reproducing the sniplink corruption pattern: run `writeWizardEnvFile()`, then `fs.appendFile(envFilePath, 'NEW_KEY=value\n')`, then parse the file line-by-line (`\n`-split, split-on-first-`=`) and assert every original key retains its exact value AND `NEW_KEY` maps to `value` (FR-005, SC-003).

## Phase 3: Validation
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [ ] T005 [US1] Run `pnpm --filter @generacy-ai/control-plane test wizard-env-writer` — must be green (SC-001).
- [ ] T006 [US1] Run the full `@generacy-ai/control-plane` test suite — must be green, confirming zero behavioural regression for existing readers (SC-002).

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (implementation) → Phase 2 (tests) → Phase 3 (validation)

**Parallel opportunities within Phase 2**:
- T003 and T004 are marked `[P]` — both add new independent tests to the same file. If executed concurrently, coordinate insertion points to avoid merge conflicts (both append to the end of the existing `describe` block for `writeWizardEnvFile`). Otherwise land T003 then T004 sequentially — safer given the shared file.
- T002 must complete before T003/T004 land in the same PR (it edits an existing assertion; the new tests coexist with it).

**File-level dependencies**:
- T001 edits `wizard-env-writer.ts`; T002–T004 edit `wizard-env-writer.test.ts`. Phases are logically ordered (fix first, then tests), but tests can be authored before the fix lands — they will fail until T001 completes, providing red→green validation of the invariant.

## Next Step

`/speckit:implement` to execute the tasks.
