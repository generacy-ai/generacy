# Data Model: Debug Adapter Integration

## Core Entities

### ExecutorEventBridge

New entity that connects executor events to debug state.

```typescript
interface ExecutorEventBridge {
  executor: WorkflowExecutor;
  state: DebugExecutionState;
  connected: boolean;

  connect(): void;
  disconnect(): void;
  handleEvent(event: ExecutionEvent): void;
}
```

### Extended StepState (for Debug Hooks)

Extends the existing `StepState` in `debug-integration.ts` to carry breakpoint-compatible location info.

```typescript
interface StepState {
  // Existing fields
  phaseName: string;
  stepName: string;
  stepIndex: number;
  phaseIndex: number;
  inputs: Record<string, unknown>;
  env: Record<string, string>;

  // New fields for breakpoint integration
  breakpointLocation?: BreakpointLocation;  // From breakpoints.ts
  executionContext?: ExecutionContext;        // For variable inspection
}
```

### SingleStepRequest

Input for the new `executeSingleStep()` API on `WorkflowExecutor`.

```typescript
interface SingleStepRequest {
  step: WorkflowStep;
  phase: WorkflowPhase;
  context: ExecutionContext;
  phaseIndex: number;
  stepIndex: number;
}
```

### SingleStepResult

Output from `executeSingleStep()`.

```typescript
interface SingleStepResult {
  success: boolean;
  output: StepOutput | null;
  error: Error | null;
  duration: number;
  skipped: boolean;
}
```

### DebugLaunchConfig (Extended)

Extended launch configuration for error pause support.

```typescript
interface DebugLaunchConfig {
  // Existing fields
  type: 'generacy-workflow';
  request: 'launch';
  name: string;
  workflow: string;           // Path to workflow YAML
  stopOnEntry: boolean;       // Pause at first step
  dryRun?: boolean;           // Don't execute actions

  // New fields
  pauseOnError: boolean;      // Default: true (opt-out per D3)
}
```

## Type Relationships

```
WorkflowDebugAdapter
  ├── has DebugSession (1:1)
  │     ├── uses WorkflowExecutor (delegation)
  │     ├── has ExecutorEventBridge (1:1)
  │     └── has DebugExecutionState (1:1)
  ├── has BreakpointManager (1:1, singleton)
  └── has WorkflowDebugConfigurationProvider (1:1)

WorkflowExecutor
  ├── has DebugHooks (1:1)
  │     └── delegates to BreakpointManager
  ├── has ExecutionContext (1:1 per execution)
  └── emits ExecutionEvent → EventBridge listens

DebugExecutionState
  ├── updated by EventBridge
  ├── read by VariablesViewProvider
  ├── read by WatchExpressionsManager
  ├── read by ExecutionHistoryProvider
  └── read by ErrorAnalysisManager
```

## Variable Scope Model (DAP)

Three scopes as decided in clarification Q2:

```
Scopes (during step pause)
├── Inputs (variablesReference: N)
│   ├── step.with parameters (after interpolation)
│   └── step.env variables
├── Outputs (variablesReference: N+1)
│   ├── current step output (if after execution)
│   ├── previous steps' outputs (keyed by step name)
│   └── exitCode, duration metadata
└── Workflow (variablesReference: N+2)
    ├── workflow-level env variables
    ├── workflow-level variables
    └── execution metadata (status, phase, step)
```

## Event Flow Model

```
Executor Event             Bridge Translation          State Update
─────────────              ──────────────              ────────────
execution:start     →      initialize workflow    →    state.startWorkflow()
phase:start         →      start phase           →    state.startPhase(name)
step:start          →      start step + inputs   →    state.startStep(name) + setVariable(inputs)
step:complete       →      complete + outputs     →    state.completeStep() + setVariable(outputs)
step:error          →      fail + error info     →    state.fail() + ErrorAnalysis.addError()
phase:complete      →      complete phase        →    state.completePhase()
execution:complete  →      complete workflow      →    state.complete()
```

## Validation Rules

- `SingleStepRequest.step` must have a valid `action` field
- `BreakpointLocation` must have either `phaseName` + `stepName` or just `stepName`
- `pauseOnError` defaults to `true` if not specified in launch config
- `ExecutorEventBridge` must be connected before execution starts
- `ExecutorEventBridge` must be disconnected on session termination to prevent memory leaks
