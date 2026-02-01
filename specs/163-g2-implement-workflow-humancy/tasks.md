# Tasks: G2 - Implement Workflow with Humancy Checkpoints

**Input**: Design documents from `/specs/163-g2-implement-workflow-humancy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story/acceptance criterion this task belongs to

## Phase 1: Filesystem Store Implementation

- [x] T001 Create `packages/workflow-engine/src/store/filesystem-store.ts` with WorkflowStore interface implementation
- [x] T002 [P] Add WorkflowState, PendingReview, StepOutput type definitions to `packages/workflow-engine/src/types/store.ts`
- [x] T003 Implement state validation (version check, schema validation) in filesystem-store.ts
- [x] T004 Add filesystem-store export to `packages/workflow-engine/src/store/index.ts`
- [x] T005 Write unit tests for filesystem-store in `packages/workflow-engine/src/store/filesystem-store.test.ts`

## Phase 2: HumancyReviewAction Implementation

- [x] T010 [AC1] Create `packages/workflow-engine/src/actions/humancy-review.ts` with HumancyReviewAction class extending BaseAction
- [x] T011 [P] Add HumancyReviewInput, HumancyReviewOutput type definitions to action file or types directory
- [x] T012 [AC1] Implement canHandle() for 'humancy.request_review' action type
- [x] T013 [AC1] Implement validate() to check artifact/context requirements
- [x] T014 [AC2][AC3] Implement executeInternal() with state persistence and HumanHandler integration
- [x] T015 [AC4] Handle approval/rejection responses, return HumancyReviewOutput
- [x] T016 [AC6] Add error handling for timeout and failure scenarios

## Phase 3: Action Registration and Integration

- [x] T020 [AC2] Register HumancyReviewAction in `packages/workflow-engine/src/actions/index.ts`
- [x] T021 [P] Add 'humancy.request_review' to ActionType union in type definitions
- [x] T022 [AC5] Implement workflow resume logic - detect pending state on executor start
- [x] T023 [AC5] Add resume entry point to workflow executor for continuing from checkpoint

## Phase 4: Testing and Validation

- [x] T030 Write unit tests for HumancyReviewAction in `packages/workflow-engine/src/actions/humancy-review.test.ts`
- [x] T031 [P] Write integration test with mock HumanHandler in `packages/workflow-engine/src/actions/humancy-review.integration.test.ts`
- [x] T032 Test state persistence across action execution (save checkpoint, resume)
- [x] T033 [AC6] Test error scenarios: timeout, invalid input, HumanHandler failure
- [x] T034 Verify conditional step execution works with `${steps.review.approved}` syntax

## Dependencies & Execution Order

### Phase Dependencies
- Phase 1 (Store) must complete before Phase 2 (Action Implementation)
- Phase 2 must complete before Phase 3 (Registration/Integration)
- Phase 3 must complete before Phase 4 (Testing)

### Parallel Opportunities
- T001 and T002 can run in parallel (different files)
- T010 and T011 can run in parallel (different files)
- T020 and T021 can run in parallel (different files)
- T030 and T031 can run in parallel (independent test files)

### Key Dependencies
- T003 depends on T002 (needs type definitions)
- T014 depends on T001 (needs filesystem store)
- T014 depends on existing HumanHandler (external dependency)
- T022, T023 depend on T001 (state persistence required for resume)
- All Phase 4 tests depend on implementation completion

### Acceptance Criteria Mapping
- **AC1** (Workflow runner): T010, T012, T013
- **AC2** (spec_kit MCP integration): T014, T020
- **AC3** (Humancy checkpoint pausing): T014
- **AC4** (Approval/rejection handling): T015
- **AC5** (Workflow resume): T022, T023
- **AC6** (Error handling): T016, T033
