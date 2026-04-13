# Tasks: Add optional role field to DefaultsConfigSchema

**Input**: Design documents from `/specs/459-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema Change

- [ ] T001 [US1] Add `role: z.string().optional()` to `DefaultsConfigSchema` in `packages/generacy/src/config/schema.ts` (after `baseBranch` field, ~line 94)

## Phase 2: Tests & Fixtures

- [ ] T002 [P] [US1] Add test case: config with `role` set parses correctly (`{ role: 'developer' }`) in `packages/generacy/src/config/__tests__/schema.test.ts`
- [ ] T003 [P] [US1] Add test case: config without `role` parses correctly (undefined) in `packages/generacy/src/config/__tests__/schema.test.ts`
- [ ] T004 [P] [US1] Add test case: config with `role` and other defaults fields (`agent`, `baseBranch`, `role`) in `packages/generacy/src/config/__tests__/schema.test.ts`
- [ ] T005 [P] [US2] Update `packages/generacy/src/config/__tests__/fixtures/valid-full.yaml` — add `role: developer` to defaults section
- [ ] T006 [P] [US1] Create `packages/generacy/src/config/__tests__/fixtures/valid-with-role.yaml` — new fixture with role field

## Phase 3: Verification

- [ ] T007 [US2] Run `pnpm test` in generacy package — confirm all existing and new tests pass
- [ ] T008 [US2] Audit `valid-with-defaults.yaml` and `valid-minimal.yaml` fixtures — verify they still parse without `role` field (backwards compatibility)

## Dependencies & Execution Order

- **T001** must complete first — all other tasks depend on the schema change being in place
- **T002–T006** can all run in parallel after T001 (they modify different files or independent sections)
- **T007–T008** must wait for T002–T006 to complete (verification of all changes)
