# Tasks: CLI scaffolder hardcodes REPO_BRANCH=main

**Input**: Design documents from `/specs/651-repro-1-github-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [ ] T001 [US1] Remove `?? 'main'` fallback from `repoBranch` assignment in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (line ~279). Change `const repoBranch = input.repoBranch ?? 'main'` to `const repoBranch = input.repoBranch`
- [ ] T002 [US1] Make the `REPO_BRANCH=` line conditional in the env lines array in `scaffolder.ts` (line ~294-295). Use spread syntax: `...(repoBranch ? [\`REPO_BRANCH=${repoBranch}\`] : [])` so the line is omitted when no branch is specified

## Phase 2: Test Updates

- [ ] T003 [US1] Update existing assertion in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (line ~387) — if test does not pass explicit `repoBranch`, change to assert `REPO_BRANCH` is absent from generated `.env`
- [ ] T004 [US1] Update "uses defaults for optional fields" test (line ~457) — assert `REPO_BRANCH` line is omitted when `repoBranch` is not provided
- [ ] T005 [P] [US1] Add test case: no `repoBranch` provided → `REPO_BRANCH` line absent from `.env` output
- [ ] T006 [P] [US2] Add test case: explicit `repoBranch: 'develop'` → `.env` contains `REPO_BRANCH=develop`
- [ ] T007 [P] [US2] Add test case: explicit `repoBranch: 'main'` → `.env` contains `REPO_BRANCH=main` (opt-in, not default)

## Phase 3: Verification

- [ ] T008 Run `pnpm test` in `packages/generacy` and confirm all tests pass
- [ ] T009 Verify SC-001: no hardcoded `'main'` fallback for `repoBranch` remains in `scaffolder.ts`

## Dependencies & Execution Order

- **T001 → T002**: T002 depends on T001 (same variable removed in T001 is used conditionally in T002). In practice these are a single atomic edit.
- **T003, T004**: Depend on T001+T002 (existing tests will fail until the production code is updated).
- **T005, T006, T007**: Marked `[P]` — these are independent new test cases that can be written in parallel.
- **T008, T009**: Final verification — depend on all prior tasks.

**Parallel opportunities**: T005, T006, T007 can be written simultaneously since they are independent test cases in the same file with no data dependencies.
