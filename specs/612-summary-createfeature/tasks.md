# Tasks: Remove hardcoded 999 cap in createFeature()

**Input**: Design documents from `/specs/612-summary-createfeature/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [US1] Remove the `> 999` guard block in `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` (lines 299-309)
- [X] T002 [P] [US2] Add `error: 'Could not find repository root'` to the failure return at `feature.ts` lines 279-287
- [X] T003 [P] [US2] Add `error` field (e.g., `` `Invalid branch name: ${branchName}` ``) to the failure return at `feature.ts` lines 317-326
- [X] T004 [P] [US1] Update JSDoc on `CreateFeatureInput.number` in `packages/workflow-engine/src/actions/builtin/speckit/types.ts` line 37 — change `(1-999)` to remove range restriction

## Phase 2: Tests

- [X] T005 [US1] Add test cases for feature numbers >= 1000 in `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` — cover 1000, 9999, and correct branch name generation with 4+ digit numbers
- [X] T006 [P] [US2] Add test cases verifying all failure paths return a populated `error` field

## Dependencies & Execution Order

- **Phase 1** tasks T001–T004 are all independent single-line/block edits in different locations — all can run in parallel.
- **Phase 2** depends on Phase 1 (tests validate the changes).
- T005 and T006 are in different test blocks and can run in parallel within Phase 2.
