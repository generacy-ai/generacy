# Tasks: Remove Role Selection from Bootstrap Wizard

**Input**: Design documents from `/specs/582-problem-bootstrap-wizard-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Delete Source Files

- [ ] T001 [P] [US2] Delete `packages/control-plane/src/routes/roles.ts` (GET/PUT `/roles/:id` handlers)
- [ ] T002 [P] [US2] Delete `packages/control-plane/src/services/default-role-writer.ts` (`setDefaultRole` service)

## Phase 2: Update Source Files

- [ ] T003 [P] [US2] Update `packages/control-plane/src/schemas.ts` — remove `'set-default-role'` from `LifecycleActionSchema` enum, delete `SetDefaultRoleBodySchema` and `SetDefaultRoleBody` type export
- [ ] T004 [P] [US2] Update `packages/control-plane/src/router.ts` — remove `handleGetRole`/`handlePutRole` import and the two `/roles/:id` route entries
- [ ] T005 [P] [US2] Update `packages/control-plane/src/routes/lifecycle.ts` — remove `SetDefaultRoleBodySchema` import, `setDefaultRole` import, and the `set-default-role` handler block
- [ ] T006 [P] [US2] Update `packages/control-plane/src/index.ts` — remove `SetDefaultRoleBodySchema` and `SetDefaultRoleBody` re-exports

## Phase 3: Delete Test Files

- [ ] T007 [P] [US2] Delete `packages/control-plane/__tests__/routes/roles.test.ts`
- [ ] T008 [P] [US2] Delete `packages/control-plane/__tests__/services/default-role-writer.test.ts`

## Phase 4: Update Test Files

- [ ] T009 [P] [US2] Update `packages/control-plane/__tests__/routes/lifecycle.test.ts` — remove `setDefaultRole` mock and `set-default-role` test cases
- [ ] T010 [P] [US2] Update `packages/control-plane/__tests__/router.test.ts` — remove role routing test cases
- [ ] T011 [P] [US2] Update `packages/control-plane/__tests__/integration/all-routes.test.ts` — remove role endpoint test cases

## Phase 5: Verify

- [ ] T012 [US1] Run `tsc --noEmit` in `packages/control-plane` — confirm clean build (SC-002)
- [ ] T013 [US1] Run test suite for control-plane — confirm all remaining tests pass (SC-003)
- [ ] T014 [US2] Grep for zero remaining references: `grep -r 'set-default-role\|SetDefaultRole\|handleGetRole\|handlePutRole\|default-role-writer' packages/control-plane/src/` (SC-001)

## Dependencies & Execution Order

**Phase 1 → Phase 2**: Source file deletions must happen before (or simultaneously with) import removal to avoid build errors during intermediate states. In practice, all of Phase 1 + Phase 2 can be done in a single pass since the files being deleted are only imported by the files being edited.

**Phase 2 tasks are all parallel**: Each edits a different file with no cross-dependencies.

**Phase 3 → Phase 4**: Test file deletions are independent of test file edits. All tasks in Phase 3 and Phase 4 can run in parallel.

**Phase 5 is sequential**: T012 (build) should run first, then T013 (tests), then T014 (grep). Each validates a different success criterion.

**Parallel opportunities**: T001-T002 parallel; T003-T006 parallel; T007-T008 parallel; T009-T011 parallel. Phases 1-4 can effectively all run in parallel since deletions and edits target separate files.
