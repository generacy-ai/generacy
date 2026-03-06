# Tasks: Failed Phase Labels for Workflow Errors

**Input**: Design documents from `/specs/328-problem-when-workflow-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Label Definitions

- [ ] T001 [P] Add `failed:*` label definitions to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts` — add 6 labels (`failed:specify`, `failed:clarify`, `failed:plan`, `failed:tasks`, `failed:implement`, `failed:validate`) with color `D73A4A` and description `"Phase {phase} failed"`, placed after existing `completed:*` block

## Phase 2: Core Implementation

- [ ] T002 [P] Update `LabelManager.onError()` in `packages/orchestrator/src/worker/label-manager.ts` to add `failed:${phase}` alongside `agent:error` in the `addLabels` call
- [ ] T003 [P] Add `failed:*` label cleanup in `packages/orchestrator/src/services/label-monitor-service.ts` — add `FAILED_LABEL_PREFIX = 'failed:'` constant and update `processLabelEvent()` to filter and remove `failed:*` labels alongside existing `completed:*` cleanup

## Phase 3: Tests

- [ ] T004 [P] Update `onError` test in `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` to expect `failed:<phase>` in the `addLabels` call
- [ ] T005 [P] Add test in `packages/orchestrator/tests/unit/services/label-monitor-service.test.ts` verifying `failed:*` labels are removed on `process` events

## Dependencies & Execution Order

- **T001** has no dependencies — can start immediately
- **T002, T003** can run in parallel (different files, independent changes); conceptually depend on T001 but no import dependency
- **T004, T005** can run in parallel; each tests the corresponding implementation task (T002→T004, T003→T005)
- All phases can practically run in parallel since there are no hard code dependencies between tasks — the label definitions in T001 are used by convention, not by import in T002/T003
