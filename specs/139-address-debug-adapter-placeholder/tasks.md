# Tasks: Address Debug Adapter Placeholder Implementations

**Input**: Design documents from `/specs/139-address-debug-adapter-placeholder/`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Step-Out Phase Boundary Tracking

- [ ] T001 Add `stepOutTarget` property to `WorkflowRuntime` class in `packages/generacy-extension/src/debug/runtime.ts` to track the target phase for step-out operations
- [ ] T002 Implement `stepOut()` method in `packages/generacy-extension/src/debug/runtime.ts` to set the target phase and continue execution until phase boundary
- [ ] T003 Modify execution loop in `runExecution()` method in `packages/generacy-extension/src/debug/runtime.ts` to check for phase boundary and pause when `stepOutTarget` is reached
- [ ] T004 Add tests for step-out phase boundary behavior in `packages/generacy-extension/src/debug/__tests__/runtime.test.ts`

## Phase 2: Nested Variable Expansion

- [ ] T005 [P] Add `nestedVariableReferences` map to `ExecutionState` class in `packages/generacy-extension/src/debug/state.ts` to track nested object references
- [ ] T006 [P] Implement `createChildReference()` method in `packages/generacy-extension/src/debug/state.ts` to create proper variable references for nested objects/arrays
- [ ] T007 Implement `getNestedVariables()` method in `packages/generacy-extension/src/debug/state.ts` to return children of complex values with 1-level depth limit
- [ ] T008 Add tests for nested variable expansion in `packages/generacy-extension/src/debug/__tests__/state.test.ts`

## Phase 3: Error Pause Support

- [ ] T009 Add `pauseOnError` launch configuration option to `packages/generacy-extension/src/debug/runtime.ts`
- [ ] T010 Modify error handling in `runExecution()` to emit stopped event with reason 'exception' when `pauseOnError` is true in `packages/generacy-extension/src/debug/runtime.ts`
- [ ] T011 Add `skipStep()` method to `WorkflowRuntime` class in `packages/generacy-extension/src/debug/runtime.ts` to skip failed step and continue execution
- [ ] T012 [P] Update protocol handler in `packages/generacy-extension/src/debug/protocol.ts` to send exception event with skip capability
- [ ] T013 Add tests for error pause functionality in `packages/generacy-extension/src/debug/__tests__/runtime.test.ts`

## Phase 4: Documentation and Cleanup

- [ ] T014 [P] Update or remove placeholder comments in `runtime.ts` with proper implementation notes
- [ ] T015 [P] Update placeholder comment in `state.ts:createChildReference()` to document the implementation
- [ ] T016 Run full test suite to verify existing tests still pass

## Dependencies & Execution Order

**Sequential dependencies within phases:**
- Phase 1: T001 → T002 → T003 → T004 (each builds on previous)
- Phase 2: T005 and T006 can run in parallel, then T007 depends on both, then T008
- Phase 3: T009 → T010 → T011, T012 can run in parallel with T010-T011, then T013

**Parallel opportunities:**
- T005 and T006 can run in parallel (different aspects of state tracking)
- T012 can run in parallel with T010-T011 (different files: protocol.ts vs runtime.ts)
- T014 and T015 can run in parallel (cleanup in different files)

**Phase boundaries:**
- Phase 2 can start after Phase 1 completes (core runtime changes needed first)
- Phase 3 can start after Phase 1 completes (error handling builds on runtime patterns)
- Phase 4 should run last to verify everything works together
