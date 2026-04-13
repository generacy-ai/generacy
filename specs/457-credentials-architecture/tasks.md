# Tasks: Fix pre-existing test failures in claude-cli-worker.test.ts

**Input**: Design documents from `/specs/457-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Fix Mock Default

- [X] T001 [US1][US2] Update `has_changes` mock default from `false` to `true` on line 24 of `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`

## Phase 2: Verification

- [X] T002 [US1] Run `pnpm test` in orchestrator package — confirm 61/61 tests pass with 0 skips
- [X] T003 [P] [US2] Audit `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts` for same `has_changes: false` default issue — confirm no fix needed (doesn't test implement phase)
- [X] T004 [P] [US2] Grep all other orchestrator test files for `has_changes` references — confirm no other files affected

## Dependencies & Execution Order

- **T001** must complete first (the fix)
- **T002** depends on T001 (verifies the fix)
- **T003** and **T004** can run in parallel with each other, and in parallel with T002 (read-only audit)

## Notes

- Only 1 file is modified: `claude-cli-worker.test.ts`
- No production code changes
- The `beforeEach` on line 193 already sets `has_changes: true`; T001 aligns the initial declaration to match
