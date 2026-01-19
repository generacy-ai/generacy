# Implementation Plan: Workflow Engine

**Feature**: Core workflow engine that orchestrates SDLC workflows
**Branch**: `003-workflow-engine-implementation`
**Status**: Complete

## Summary

This feature implements the core workflow engine for Generacy, providing orchestration of multi-step SDLC workflows including agent steps, human review gates, conditional branching, and parallel execution. The engine supports state persistence via a pluggable storage adapter (SQLite default) and emits events for all state transitions.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript 5.x |
| Runtime | Node.js 20+ |
| Storage | SQLite (via better-sqlite3) with pluggable adapter |
| Testing | Vitest |
| Build | tsup (ESM-first) |
| Linting | ESLint + Prettier |

## Project Structure

```text
/workspaces/generacy/
├── package.json                        # Root package configuration
├── tsconfig.json                       # TypeScript configuration
├── vitest.config.ts                    # Test configuration
├── src/
│   ├── index.ts                        # Public API exports
│   ├── engine/
│   │   ├── WorkflowEngine.ts           # Main orchestration class
│   │   ├── WorkflowRuntime.ts          # Single workflow execution runtime
│   │   └── index.ts                    # Engine exports
│   ├── types/
│   │   ├── WorkflowDefinition.ts       # Workflow and step definitions
│   │   ├── WorkflowState.ts            # Runtime state types
│   │   ├── WorkflowContext.ts          # Execution context
│   │   ├── WorkflowEvent.ts            # Event types
│   │   ├── ErrorHandler.ts             # Error handling types
│   │   ├── StorageAdapter.ts           # Storage interface
│   │   └── index.ts                    # Type exports
│   ├── execution/
│   │   ├── StepExecutor.ts             # Base step execution
│   │   ├── AgentStepExecutor.ts        # Agent command execution
│   │   ├── HumanStepExecutor.ts        # Human review handling
│   │   ├── ConditionEvaluator.ts       # Property path evaluation
│   │   ├── ParallelExecutor.ts         # Parallel branch execution
│   │   └── index.ts                    # Execution exports
│   ├── storage/
│   │   ├── SQLiteStorageAdapter.ts     # SQLite implementation
│   │   ├── InMemoryStorageAdapter.ts   # In-memory for testing
│   │   └── index.ts                    # Storage exports
│   ├── events/
│   │   ├── WorkflowEventEmitter.ts     # Event emission
│   │   └── index.ts                    # Event exports
│   └── utils/
│       ├── PropertyPathParser.ts       # Parse "context.foo.bar" expressions
│       ├── IdGenerator.ts              # UUID generation
│       └── index.ts                    # Utils exports
├── tests/
│   ├── unit/
│   │   ├── engine.test.ts
│   │   ├── condition-evaluator.test.ts
│   │   ├── property-path.test.ts
│   │   └── storage.test.ts
│   ├── integration/
│   │   ├── workflow-execution.test.ts
│   │   └── persistence.test.ts
│   └── fixtures/
│       ├── workflows.ts                # Test workflow definitions
│       └── contexts.ts                 # Test contexts
└── workflows/
    └── standard-development.yaml       # Built-in workflow definition
```

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                     WorkflowEngine                          │
│  - Manages multiple workflow instances                      │
│  - Handles lifecycle (initialize/shutdown)                  │
│  - Routes events to subscribers                             │
└─────────────────┬───────────────────────────────────────────┘
                  │ creates/manages
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    WorkflowRuntime                          │
│  - Executes single workflow instance                        │
│  - Manages state machine transitions                        │
│  - Coordinates step executors                               │
└─────────────────┬───────────────────────────────────────────┘
                  │ delegates to
                  ▼
┌─────────────────────────────────────────────────────────────┐
│                    Step Executors                           │
│  AgentStepExecutor │ HumanStepExecutor │ ParallelExecutor   │
│  ConditionEvaluator                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Storage Layer                            │
│  StorageAdapter (interface)                                 │
│  ├─ SQLiteStorageAdapter (default)                          │
│  └─ InMemoryStorageAdapter (testing)                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    Event System                             │
│  WorkflowEventEmitter                                       │
│  - workflow:started, workflow:completed, workflow:failed    │
│  - step:started, step:completed, step:failed               │
│  - human:waiting, human:resolved                           │
└─────────────────────────────────────────────────────────────┘
```

### State Machine

```
                    ┌──────────────┐
                    │   CREATED    │
                    └──────┬───────┘
                           │ start()
                           ▼
                    ┌──────────────┐
          ┌────────│   RUNNING    │────────┐
          │        └──────┬───────┘        │
          │               │                │
     pause()         complete()        cancel()
          │               │                │
          ▼               ▼                ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │   PAUSED     │ │  COMPLETED   │ │  CANCELLED   │
   └──────┬───────┘ └──────────────┘ └──────────────┘
          │
     resume()
          │
          ▼
   ┌──────────────┐
   │   RUNNING    │
   └──────────────┘
```

### Step Execution Flow

```
1. Get current step from definition
2. Determine step type (agent/human/condition/parallel)
3. Delegate to appropriate executor
4. Handle result:
   - Success: Persist state, emit event, advance to next step
   - Human wait: Persist state, emit waiting event
   - Error: Apply error handler (retry/abort/escalate)
5. Repeat until terminal state
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage adapter pattern | Pluggable interface | Allows SQLite for local, swappable for cloud/teams |
| Parallel step type | Explicit `parallel` type | Cleaner than overloading `next`, matches spec |
| Condition evaluation | Property path syntax | Secure (no eval), expressive, easy to debug |
| Error handling MVP | retry + abort + escalate | Core actions first, extensible later |
| Type definitions | Local first | Stabilize before extracting to contracts |
| Event system | Simple emitter | Sufficient for initial needs, upgradeable |

## Implementation Phases

### Phase 1: Foundation
- Project setup (package.json, tsconfig, vitest)
- Type definitions (WorkflowDefinition, Step types, State types)
- Storage adapter interface + in-memory implementation

### Phase 2: Core Engine
- WorkflowEngine class (lifecycle, workflow management)
- WorkflowRuntime class (single workflow execution)
- Basic step execution (sequential, no parallelism)
- State persistence with SQLite adapter

### Phase 3: Step Executors
- AgentStepExecutor (command invocation placeholder)
- HumanStepExecutor (pause and resume handling)
- ConditionEvaluator (property path parsing and evaluation)
- ParallelExecutor (concurrent branch execution)

### Phase 4: Error Handling & Events
- Error handler implementation (retry, abort, escalate)
- Event system (workflow and step events)
- Timeout handling

### Phase 5: Integration
- Built-in workflow definitions (standard-development.yaml)
- Integration tests
- Documentation

## API Surface

```typescript
// Main entry point
import { WorkflowEngine, type WorkflowDefinition } from 'generacy';

// Create engine with default SQLite storage
const engine = new WorkflowEngine();
await engine.initialize();

// Or with custom storage
const engine = new WorkflowEngine({
  storage: new InMemoryStorageAdapter(),
});

// Start a workflow
const workflowId = await engine.startWorkflow(definition, context);

// Control workflow
await engine.pauseWorkflow(workflowId);
await engine.resumeWorkflow(workflowId);
await engine.cancelWorkflow(workflowId);

// Query
const workflow = await engine.getWorkflow(workflowId);
const workflows = await engine.listWorkflows({ status: 'running' });

// Subscribe to events
engine.onWorkflowEvent((event) => {
  console.log(`${event.type}: ${event.workflowId}`);
});

// Cleanup
await engine.shutdown();
```

## Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| better-sqlite3 | SQLite storage adapter | ^11.0.0 |
| uuid | Workflow ID generation | ^10.0.0 |
| vitest | Testing framework | ^2.0.0 |
| tsup | Build tool | ^8.0.0 |
| typescript | Language | ^5.5.0 |
| eslint | Linting | ^9.0.0 |
| prettier | Formatting | ^3.0.0 |

## Verification Checklist

- [ ] Workflows start and progress through steps
- [ ] Human steps pause until input provided
- [ ] Agent steps ready for command integration
- [ ] State persists to SQLite and recovers on restart
- [ ] Condition steps evaluate property paths correctly
- [ ] Parallel steps execute branches concurrently
- [ ] Error handler retries, aborts, or escalates as configured
- [ ] Events emitted for all state transitions
- [ ] Timeouts cancel steps/workflows appropriately

## Next Steps

After plan approval:
1. Run `/speckit:tasks` to generate detailed task list
2. Begin Phase 1 implementation (project setup)

---

*Generated by speckit*
