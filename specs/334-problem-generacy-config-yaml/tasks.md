# Tasks: Template Config Format Support

**Input**: Design documents from `/specs/334-problem-generacy-config-yaml/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Conversion Logic

- [X] T001 [P] Create template config Zod schema (`packages/config/src/template-schema.ts`)
- [X] T002 [P] Create template-to-workspace converter (`packages/config/src/convert-template.ts`)

## Phase 2: Loader Integration

- [X] T003 Add template format fallback to `tryLoadWorkspaceConfig()` in `packages/config/src/loader.ts`
- [X] T004 Export new modules from `packages/config/src/index.ts`

## Phase 3: Tests

- [X] T005 [P] Write template schema validation tests (`packages/config/src/__tests__/template-schema.test.ts`)
- [X] T006 [P] Write conversion logic tests (`packages/config/src/__tests__/convert-template.test.ts`)
- [X] T007 [P] Add template fallback integration tests to `packages/config/src/__tests__/loader.test.ts`

## Dependencies & Execution Order

- **Phase 1**: T001 and T002 are independent and can run in parallel. T002 depends on the `TemplateConfigSchema` type but not the runtime — can be developed concurrently using the shared type definition.
- **Phase 2**: T003 depends on both T001 and T002 (imports schema + converter). T004 depends on T001 and T002 existing.
- **Phase 3**: T005, T006, T007 can all run in parallel. They depend on Phase 2 being complete so the modules are importable.

**Parallel opportunities**: 2 in Phase 1, 3 in Phase 3. Total 5 of 7 tasks can be parallelized within their phase.
