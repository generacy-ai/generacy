# Tasks: Complete Workflow Step Execution Engine

**Input**: Design documents from `/specs/147-complete-workflow-step-execution/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story/acceptance criteria this task addresses

## Phase 1: Debug Hook Integration

- [ ] T001 [AC6] Wire debug hooks into `executeStep()` - Import `getDebugHooks()` and call `beforeStep()` before action execution in `executor.ts:190-220`
- [ ] T002 [AC6] Add `afterStep()` hook call after action completes with `StepState` and `ActionResult` in `executor.ts`
- [ ] T003 [AC4] Add action-level timeout wrapper using `withTimeout()` from `retry/index.ts` around handler.execute() in `executor.ts`

## Phase 2: Integration Tests

- [ ] T004 [P] [AC1] Create test file `executor.test.ts` with test setup and mock utilities for action handlers
- [ ] T005 [P] [AC1] Test `workspace.prepare` action with mock git operations - verify branch creation/checkout
- [ ] T006 [P] [AC2] Test `agent.invoke` action with mock Claude Code CLI - verify command construction and output parsing
- [ ] T007 [P] [AC4] Test timeout enforcement at action level - verify long-running actions are terminated
- [ ] T008 [P] [AC6] Test debug hook pause/resume - verify `beforeStep()` can pause and `resume()` continues execution
- [ ] T009 [AC3] Test step output capture and interpolation - verify `${steps.id.output}` works across steps
- [ ] T010 [AC5] Test error handling chain - verify errors propagate correctly and `continueOnError` works

## Phase 3: Manual Validation

- [ ] T011 (manual) Run sample workflow with `workspace.prepare` step and verify git branch operations
- [ ] T012 (manual) Run workflow with `agent.invoke` step and verify Claude Code CLI invocation
- [ ] T013 (manual) Verify debugger can set breakpoints and pause at step boundaries in VS Code
- [ ] T014 (manual) Run complete workflow with all action types and verify outputs flow between steps

## Dependencies & Execution Order

**Phase 1 (Sequential)**:
- T001 → T002 → T003 (debug hooks must be wired before timeout wrapper to ensure hooks still fire on timeout)

**Phase 2 (Mostly Parallel)**:
- T004 creates test infrastructure, then T005-T010 can largely run in parallel
- T009 depends on T004 (test setup)
- T010 depends on T004 (test setup)

**Phase 3 (Manual, Sequential)**:
- T011 → T012 → T013 → T014 (validate incrementally)

## Acceptance Criteria Mapping

| AC | Description | Tasks |
|----|-------------|-------|
| AC1 | Run workspace.prepare step | T005, T011 |
| AC2 | Invoke Claude Code via agent.invoke | T006, T012 |
| AC3 | Step outputs captured for subsequent steps | T009, T014 |
| AC4 | Timeouts enforced per step | T003, T007 |
| AC5 | Errors caught and reported | T010 |
| AC6 | Debugger pause/resume at step boundaries | T001, T002, T008, T013 |

## Files to Modify

- `packages/generacy-extension/src/views/local/runner/executor.ts` - T001, T002, T003
- `packages/generacy-extension/src/views/local/runner/__tests__/executor.test.ts` (new) - T004-T010
