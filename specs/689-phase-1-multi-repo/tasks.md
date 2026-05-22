# Tasks: Track Linked Sibling PRs in WorkflowState

**Input**: Design documents from `/specs/689-phase-1-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions & Helper

- [ ] T001 [US1] Add `LinkedPR` interface and `linkedPRs` field to `WorkflowState` in `packages/workflow-engine/src/types/store.ts`
- [ ] T002 [US1] Re-export `LinkedPR` from `packages/workflow-engine/src/types/index.ts`
- [ ] T003 [US2] Create `addLinkedPR()` pure function in `packages/workflow-engine/src/store/linked-pr.ts` — immutable state update, de-dupe on `repo + number`, update-on-duplicate
- [ ] T004 [US2] Re-export `addLinkedPR` from `packages/workflow-engine/src/store/index.ts`

## Phase 2: Validation

- [ ] T005 [US1] Add `linkedPRs` validation block in `validateWorkflowState()` in `packages/workflow-engine/src/store/filesystem-store.ts` — validate array structure and per-entry fields (`repo`, `number`, `branch`, `url`), skip if `undefined`

## Phase 3: Tests

- [ ] T006 [P] [US2] Create `packages/workflow-engine/src/store/linked-pr.test.ts` — tests for: append to undefined, append to empty, append distinct entries, de-dupe on `repo + number`, URL/branch update on duplicate, immutability of original state
- [ ] T007 [P] [US1] Add round-trip tests in `packages/workflow-engine/src/store/filesystem-store.test.ts` — save state with `linkedPRs` and read back; load state without `linkedPRs` (backward compat); validation rejects malformed `linkedPRs`

## Phase 4: Verify

- [ ] T008 Run `pnpm tsc --noEmit` in workflow-engine to verify zero type errors (SC-001)
- [ ] T009 Run full test suite to verify existing tests pass (SC-002) and new tests pass (SC-003, SC-004)

## Dependencies & Execution Order

- **T001** must complete before T002, T003, T005, T006, T007 (type dependency)
- **T002** and **T003** can run in parallel after T001
- **T003** must complete before T004, T006
- **T005** must complete before T007
- **T006** and **T007** are parallelizable (different test files)
- **T008** and **T009** are final verification — run after all prior tasks

```
T001 → T002 (parallel with T003)
T001 → T003 → T004
T001 → T005
T003 + T005 → T006 [P] T007
T006 + T007 → T008 → T009
```
