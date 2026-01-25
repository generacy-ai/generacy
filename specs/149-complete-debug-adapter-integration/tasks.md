# Tasks: Complete Debug Adapter Integration with Step Execution

**Input**: Design documents from `/specs/149-complete-debug-adapter-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions & Interfaces

- [X] T001 [US1] Add `SingleStepRequest` and `SingleStepResult` interfaces to `packages/generacy-extension/src/views/local/runner/types.ts` — define the input/output types for the new `executeSingleStep()` API per data-model.md
- [X] T002 [P] [US1] Extend `StepState` interface in `packages/generacy-extension/src/views/local/runner/debug-integration.ts` — add `breakpointLocation` and `executionContext` fields for breakpoint integration per data-model.md
- [X] T003 [P] [US1] Extend `DebugLaunchConfig` interface in `packages/generacy-extension/src/views/local/debugger/adapter.ts` — add `pauseOnError: boolean` field (default `true`) per decision D3

## Phase 2: Core Integration (Executor & Event Bridge)

- [X] T004 [US1] Implement `executeSingleStep()` method on `WorkflowExecutor` in `packages/generacy-extension/src/views/local/runner/executor.ts` — expose single-step execution API that runs one step through the action handler pipeline, returns `SingleStepResult`, and respects debug hooks (beforeStep/afterStep)
- [X] T005 [US1] Create `packages/generacy-extension/src/views/local/debugger/event-bridge.ts` — implement `ExecutorEventBridge` class that subscribes to executor `ExecutionEvent` emissions (`execution:start`, `phase:start`, `step:start`, `step:complete`, `step:error`, `phase:complete`, `execution:complete`) and translates them to `DebugExecutionState` updates per research.md event mapping table
- [X] T006 [US1] Wire `DebugHooks.findMatchingBreakpoint()` to delegate to `BreakpointManager.shouldStopAt()` in `packages/generacy-extension/src/views/local/runner/debug-integration.ts` — convert `StepState` to `BreakpointLocation` and use `BreakpointManager` as source of truth per decision D5/research.md

## Phase 3: Session Delegation & Debug Controls

- [X] T007 [US1] Replace `simulateStepExecution()` with real executor delegation in `packages/generacy-extension/src/views/local/debugger/session.ts` — `executeStep()` calls `WorkflowExecutor.executeSingleStep()`, receives `SingleStepResult`, updates session state, and catches executor errors to emit DAP exception events
- [X] T008 [US1] Initialize `ExecutorEventBridge` in `DebugSession` lifecycle in `packages/generacy-extension/src/views/local/debugger/session.ts` — create bridge on session start (`connect()`), disconnect on session termination to prevent memory leaks
- [X] T009 [US2] Wire debug controls to executor behavior in `packages/generacy-extension/src/views/local/debugger/session.ts` — implement Continue (resume to next breakpoint), Step Over (execute one step then pause), Step Into (same as Step Over for non-nested, per D7), Step Out (complete current phase then pause)
- [X] T010 [US1] Implement error pause integration in `packages/generacy-extension/src/views/local/debugger/session.ts` — read `pauseOnError` from launch config (default `true`), on step error emit DAP `stopped` event with reason `'exception'`, feed error to `ErrorAnalysisManager`

## Phase 4: Variable Population & Views

- [X] T011 [US3] Update DAP `scopes` handler in `packages/generacy-extension/src/views/local/debugger/adapter.ts` — return three scopes (Inputs, Outputs, Workflow) with proper `variablesReference` IDs per data-model.md variable scope model
- [X] T012 [US3] Update DAP `variables` handler in `packages/generacy-extension/src/views/local/debugger/adapter.ts` — populate Inputs scope from step `with` parameters after interpolation, Outputs scope from `ExecutionContext.stepOutputs`, Workflow scope from global variables; map values to DAP `Variable` objects with proper types
- [X] T013 [P] [US1] Connect history panel to real executor events in `packages/generacy-extension/src/views/local/debugger/history-panel.ts` — subscribe to event bridge: `step:start` adds "started" entry, `step:complete` adds "completed" entry with duration/output, `step:error` adds "failed" entry with error details
- [X] T014 [P] [US1] Connect error analysis to real executor events in `packages/generacy-extension/src/views/local/debugger/error-analysis.ts` — subscribe to event bridge `step:error` events for real-time error categorization and suggestions

## Phase 5: Replay & Final Wiring

- [X] T015 [US1] Update replay controller to use cached execution results in `packages/generacy-extension/src/views/local/debugger/replay-controller.ts` — replay reads from history panel's recorded results instead of re-executing through executor (recorded replay only, per D5/out-of-scope)
- [X] T016 Verify end-to-end integration — confirm the full execution flow: debug session creates event bridge, delegates to executor, breakpoints pause execution, variables show real data, debug controls advance/resume correctly, history and errors update in real-time

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Parallel opportunities within phases**:
- Phase 1: T002 and T003 can run in parallel (different files), T001 should complete first or in parallel since T002/T003 don't depend on it directly
- Phase 2: T004, T005, T006 are sequential — T004 (executor API) before T005 (bridge uses executor), T006 (hooks use breakpoint manager) can start after T002
- Phase 3: T007 depends on T004+T005; T008 depends on T005; T009 and T010 depend on T007; T009 and T010 can run in parallel
- Phase 4: T011 and T012 are sequential (scopes before variables); T013 and T014 can run in parallel with T011/T012 (different files)
- Phase 5: T015 can start once Phase 4 is done; T016 requires all prior tasks
