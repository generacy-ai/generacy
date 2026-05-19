# Tasks: Fix validate phase after worker restart

**Input**: Design documents from `/specs/454-bug-validate-phase-fails/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [US1] Update `preValidateCommand` default in `packages/orchestrator/src/worker/config.ts` — change line 29 from `'pnpm install'` to `'pnpm install && pnpm -r --filter ./packages/* build'`

## Phase 2: Test Updates

- [X] T002 [P] [US1] Update default assertion in `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` — change line 422-424 test description and `toBe()` expectation to match new default value
- [X] T003 [P] [US1] Update `preValidateCommand` value in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — update the `createConfig` helper (line 98) to use the new default value

## Phase 3: Verification

- [X] T004 Run `pnpm test` in `packages/orchestrator` to confirm all tests pass with updated default

## Dependencies & Execution Order

- **T001** must complete first (production code change)
- **T002** and **T003** can run in parallel (separate test files, both depend on T001)
- **T004** runs last to verify all changes are correct
