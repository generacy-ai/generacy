# Tasks: Workflow Engine Implementation

**Input**: Design documents from `/specs/003-workflow-engine-implementation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Foundation

### Project Setup
- [ ] T001 Initialize package.json with dependencies (better-sqlite3, uuid, vitest, tsup, typescript, eslint, prettier)
- [ ] T002 [P] Create tsconfig.json with ESM-first configuration
- [ ] T003 [P] Create vitest.config.ts for test configuration
- [ ] T004 [P] Create tsup.config.ts for build configuration

### Type Definitions
- [ ] T010 [US1] Create `src/types/WorkflowDefinition.ts` - WorkflowDefinition, WorkflowStep, StepConfig types
- [ ] T011 [P] [US1] Create `src/types/WorkflowState.ts` - WorkflowState, WorkflowStatus types
- [ ] T012 [P] [US1] Create `src/types/WorkflowContext.ts` - WorkflowContext, StepResult types
- [ ] T013 [P] [US1] Create `src/types/WorkflowEvent.ts` - WorkflowEvent, WorkflowEventType, payload types
- [ ] T014 [P] [US1] Create `src/types/ErrorHandler.ts` - ErrorHandler, ErrorAction types
- [ ] T015 [P] [US2] Create `src/types/StorageAdapter.ts` - StorageAdapter interface
- [ ] T016 Create `src/types/index.ts` - Re-export all types

### Utilities
- [ ] T020 Create `src/utils/IdGenerator.ts` - UUID generation for workflow IDs
- [ ] T021 [P] Create `src/utils/PropertyPathParser.ts` - Parse and evaluate property path expressions
- [ ] T022 Create `src/utils/index.ts` - Re-export utilities
- [ ] T023 Create `tests/unit/property-path.test.ts` - Unit tests for property path parser

---

## Phase 2: Storage Layer

### Storage Adapters
- [ ] T030 [US2] Create `src/storage/InMemoryStorageAdapter.ts` - In-memory implementation for testing
- [ ] T031 [P] [US2] Create `src/storage/SQLiteStorageAdapter.ts` - SQLite implementation with better-sqlite3
- [ ] T032 Create `src/storage/index.ts` - Re-export storage adapters
- [ ] T033 Create `tests/unit/storage.test.ts` - Unit tests for both storage adapters

---

## Phase 3: Core Engine

### Event System
- [ ] T040 Create `src/events/WorkflowEventEmitter.ts` - Typed event emitter for workflow events
- [ ] T041 Create `src/events/index.ts` - Re-export event system

### Workflow Runtime
- [ ] T050 [US1] Create `src/engine/WorkflowRuntime.ts` - Single workflow execution runtime (state machine, step advancement)
- [ ] T051 Create `tests/unit/engine.test.ts` - Unit tests for WorkflowRuntime

### Workflow Engine
- [ ] T060 [US1] Create `src/engine/WorkflowEngine.ts` - Main orchestration class (lifecycle, workflow management, queries)
- [ ] T061 Create `src/engine/index.ts` - Re-export engine classes

---

## Phase 4: Step Executors

### Base Executor
- [ ] T070 [US1] Create `src/execution/StepExecutor.ts` - Base interface and executor factory

### Specialized Executors
- [ ] T071 [P] [US1] Create `src/execution/AgentStepExecutor.ts` - Agent command execution (placeholder for actual command invocation)
- [ ] T072 [P] [US1] Create `src/execution/HumanStepExecutor.ts` - Human review handling (pause/resume workflow)
- [ ] T073 [P] [US1] Create `src/execution/ConditionEvaluator.ts` - Property path condition evaluation
- [ ] T074 [P] [US1] Create `src/execution/ParallelExecutor.ts` - Parallel branch execution with Promise.all/race
- [ ] T075 Create `src/execution/index.ts` - Re-export executors
- [ ] T076 Create `tests/unit/condition-evaluator.test.ts` - Unit tests for condition evaluation

---

## Phase 5: Error Handling & Timeout

### Error Handling
- [ ] T080 [US1] Implement error handler logic in WorkflowRuntime - retry, abort, escalate actions
- [ ] T081 Add timeout handling to WorkflowRuntime and step executors

---

## Phase 6: Integration & Public API

### Public API
- [ ] T090 Create `src/index.ts` - Public API exports (WorkflowEngine, types, adapters)

### Integration Tests
- [ ] T091 [US1] [US2] Create `tests/integration/workflow-execution.test.ts` - End-to-end workflow execution tests
- [ ] T092 [P] [US2] Create `tests/integration/persistence.test.ts` - State persistence and recovery tests

### Test Fixtures
- [ ] T093 Create `tests/fixtures/workflows.ts` - Test workflow definitions
- [ ] T094 [P] Create `tests/fixtures/contexts.ts` - Test contexts

---

## Phase 7: Built-in Workflows

### Workflow Definitions
- [ ] T100 [US1] Create `workflows/standard-development.yaml` - Built-in standard development workflow

---

## Dependencies & Execution Order

### Phase Dependencies (Sequential)
- Phase 1 (Foundation) must complete before Phase 2
- Phase 2 (Storage) must complete before Phase 3
- Phase 3 (Core Engine) must complete before Phase 4
- Phase 4 (Step Executors) must complete before Phase 5
- Phase 5 (Error Handling) must complete before Phase 6
- Phase 6 (Integration) must complete before Phase 7

### Parallel Opportunities Within Phases

**Phase 1**:
- T002, T003, T004 can run in parallel after T001
- T011, T012, T013, T014, T015 can run in parallel after T010
- T021 can run in parallel with T020

**Phase 2**:
- T030, T031 can run in parallel

**Phase 4**:
- T071, T072, T073, T074 can run in parallel after T070

**Phase 6**:
- T091, T092 can run in parallel
- T093, T094 can run in parallel

### Critical Path
```
T001 → T010 → T016 → T030 → T032 → T040 → T050 → T060 → T070 → T075 → T080 → T090 → T091
```

---

## Summary

| Phase | Task Count | Parallel Tasks |
|-------|------------|----------------|
| Phase 1: Foundation | 14 | 10 |
| Phase 2: Storage | 4 | 2 |
| Phase 3: Core Engine | 4 | 0 |
| Phase 4: Step Executors | 7 | 4 |
| Phase 5: Error Handling | 2 | 0 |
| Phase 6: Integration | 5 | 4 |
| Phase 7: Built-in Workflows | 1 | 0 |
| **Total** | **37** | **20** |

---

*Generated by speckit*
