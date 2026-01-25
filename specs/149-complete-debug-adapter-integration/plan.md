# Implementation Plan: Complete Debug Adapter Integration with Step Execution

**Feature**: Wire the DAP debug adapter to the real workflow step executor
**Branch**: `149-complete-debug-adapter-integration`
**Status**: Complete

## Summary

The debug adapter (DAP) and workflow executor are both implemented but operate as parallel code paths. The `DebugSession.executeStep()` method simulates step execution with a sleep delay instead of delegating to `WorkflowExecutor`. Additionally, `DebugExecutionState` is not automatically updated by executor events, so the variables view, history panel, and error analysis all show stale data.

This plan integrates these two subsystems by:
1. Making `DebugSession` delegate step execution to `WorkflowExecutor`
2. Creating an event bridge that synchronizes executor events to `DebugExecutionState`
3. Wiring the breakpoint manager to the executor's debug hooks
4. Populating variables with real step state (Inputs, Outputs, Workflow scopes)
5. Connecting debug controls (Step Over, Step Into, Step Out, Continue) to executor pause/resume

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API, Debug Adapter Protocol (DAP)
- **Package**: `packages/generacy-extension`
- **Key Dependencies**: `@vscode/debugprotocol`, `yaml`, `vscode`
- **Patterns**: Singleton instances, event-driven architecture, promise-based async

## Current Architecture

### Two Parallel Execution Paths (Problem)

```
Path A: Debug Adapter                   Path B: Executor
─────────────────                       ─────────────────
WorkflowDebugAdapter                    WorkflowExecutor
  └─ DebugSession                         └─ executeStep()
       └─ simulateStepExecution()              └─ action handler
            └─ setTimeout() ← FAKE              └─ real execution
```

### Target Architecture (Solution)

```
WorkflowDebugAdapter
  └─ DebugSession
       └─ executeStep()
            └─ WorkflowExecutor.executeStep()  ← REAL
                  ├─ debugHooks.beforeStep()    → BreakpointManager.shouldStopAt()
                  ├─ action handler execution   → real output
                  ├─ debugHooks.afterStep()     → update DebugExecutionState
                  └─ events                     → EventBridge → variables/history/errors
```

## Design Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | DebugSession delegates to executor, not replaces it | Executor already has retry, timeout, interpolation; avoid duplication |
| D2 | EventBridge pattern for state sync | Loose coupling; executor doesn't need to know about debug state |
| D3 | Pause on errors by default (opt-out) | Safe default per clarification Q1 answer |
| D4 | Two-level + globals variable scopes | Per clarification Q2: Inputs, Outputs, Workflow |
| D5 | Recorded replay only (no live re-execution) | Per clarification Q3: use cached history |
| D6 | Dot-notation watch expressions only | Per clarification Q4: simple syntax first |
| D7 | Step Over = next step (any phase) | Per clarification Q5: steps are primary unit |

## Project Structure

```text
packages/generacy-extension/src/views/local/
├── debugger/
│   ├── adapter.ts              # DAP adapter (modify: scope mapping)
│   ├── session.ts              # Debug session (modify: delegate to executor)
│   ├── breakpoints.ts          # Breakpoint manager (no changes)
│   ├── variables-view.ts       # Variables view (modify: real data source)
│   ├── watch-expressions.ts    # Watch expressions (no changes needed)
│   ├── history-panel.ts        # History panel (modify: real data source)
│   ├── error-analysis.ts       # Error analysis (modify: real error events)
│   ├── replay-controller.ts    # Replay (modify: use cached results)
│   └── event-bridge.ts         # NEW: executor → debug state sync
├── runner/
│   ├── executor.ts             # Executor (modify: expose single-step API)
│   ├── debug-integration.ts    # Debug hooks (modify: bridge to BreakpointManager)
│   └── types.ts                # Types (extend: debug-related interfaces)
└── debug/
    └── state.ts                # Debug state (no changes needed)
```

## Implementation Components

### Component 1: Event Bridge (New File)

**File**: `debugger/event-bridge.ts`

Creates a bridge between `WorkflowExecutor` events and `DebugExecutionState` updates. The bridge:
- Listens to executor `ExecutionEvent` emissions
- Translates `step:start`, `step:complete`, `phase:start`, `phase:complete` events
- Updates `DebugExecutionState` with real variable values from `ExecutionContext`
- Feeds history panel with real execution entries
- Feeds error analysis with real step errors

```typescript
// Conceptual API
class ExecutorEventBridge {
  constructor(executor: WorkflowExecutor, state: DebugExecutionState);
  connect(): void;    // Start listening to executor events
  disconnect(): void; // Stop listening
}
```

### Component 2: Session-Executor Delegation

**File**: `debugger/session.ts`

Replace `simulateStepExecution()` with real executor delegation:
- `executeStep()` calls `WorkflowExecutor.executeSingleStep()` instead of sleeping
- Pass the current `WorkflowStep` and `ExecutionContext` to the executor
- Receive the `StepResult` back and update session state
- Error handling: catch executor errors, emit DAP exception events

Key change:
```typescript
// Before (placeholder)
private async simulateStepExecution(step: WorkflowStep): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100));
}

// After (real)
private async executeStepViaExecutor(step: WorkflowStep): Promise<StepResult> {
  const executor = WorkflowExecutor.getInstance();
  return executor.executeSingleStep(step, this.executionContext);
}
```

### Component 3: Single-Step Executor API

**File**: `runner/executor.ts`

Expose a method for executing a single step on demand (used by debug session):
- `executeSingleStep(step, context)` — runs one step through the full action handler pipeline
- Reuses existing `executeStep()` internals but doesn't advance the phase loop
- Returns `StepResult` with output, exit code, duration, error info
- Respects debug hooks (beforeStep/afterStep) for breakpoint support

### Component 4: Breakpoint Manager Bridge

**File**: `runner/debug-integration.ts`

Wire `DebugHooks.findMatchingBreakpoint()` to use `BreakpointManager.shouldStopAt()`:
- When `beforeStep()` is called, convert step info to `BreakpointLocation`
- Call `BreakpointManager.shouldStopAt()` with the location and context
- If should stop: pause execution, emit DAP `stopped` event
- Support condition evaluation and hit counts via the existing `BreakpointManager`

### Component 5: Variable Population with Real State

**File**: `debugger/adapter.ts` (scopes handler)

Update the DAP `scopes` and `variables` handlers to pull real data:
- **Inputs scope**: Current step's `with` parameters after interpolation
- **Outputs scope**: Current step's output from `ExecutionContext.stepOutputs`
- **Workflow scope**: Global variables from `ExecutionContext`
- Map real values to DAP `Variable` objects with proper types

### Component 6: Debug Control Wiring

**File**: `debugger/session.ts`

Wire the four debug controls to executor behavior:
- **Continue**: Call `DebugHooks.resume()`, executor proceeds to next breakpoint
- **Step Over**: Execute one step via executor, then pause
- **Step Into**: Same as Step Over for non-nested workflows (per D7)
- **Step Out**: Execute remaining steps in current phase via executor, then pause

### Component 7: Error Pause Integration

**File**: `debugger/session.ts`, `runner/executor.ts`

Implement the opt-out error pause behavior (per D3):
- Add `pauseOnError` to launch configuration (default: `true`)
- When executor reports a step error during debug session:
  - If `pauseOnError` is true: emit DAP `stopped` event with reason `'exception'`
  - Feed error to `ErrorAnalysisManager` for categorization and suggestions
  - User can then Continue (skip error), Step Over (next step), or Terminate

### Component 8: History Panel Integration

**File**: `debugger/history-panel.ts`

Connect history panel to real executor events via the event bridge:
- Each `step:start` → add "started" history entry with timestamp
- Each `step:complete` → add "completed" entry with duration and output summary
- Each `step:error` → add "failed" entry with error details
- Phase boundaries tracked automatically

## Execution Flow (After Integration)

```
1. User clicks "Debug Workflow" in VS Code
2. WorkflowDebugAdapter creates DebugSession
3. DebugSession creates EventBridge(executor, debugState)
4. Session parses workflow YAML, builds location map
5. Session calls executor.executeSingleStep() for each step:
   a. Executor calls debugHooks.beforeStep()
   b. DebugHooks checks BreakpointManager.shouldStopAt()
   c. If breakpoint hit → pause, emit DAP 'stopped' event
   d. User inspects variables (real data from ExecutionContext)
   e. User clicks Continue/Step Over/Step Out
   f. DebugHooks.resume() called
   g. Executor runs action handler (real execution)
   h. Executor calls debugHooks.afterStep()
   i. EventBridge updates DebugExecutionState
   j. Variables view, history, errors all update with real data
6. Workflow completes or user terminates
```

## Dependencies

- **Internal**: Depends on #147 (step execution engine) being complete
- **External**: No new npm packages required
- Uses existing: `vscode`, `@vscode/debugprotocol`, `yaml`

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Executor state management when debug-stepping | High | Use existing ExecutionContext; don't create parallel state |
| Race conditions between debug controls and executor | Medium | Single-threaded execution model; pause/resume via Promise gate |
| Breaking existing DAP protocol behavior | Medium | Preserve all existing DAP response shapes; add real data as enhancement |
| Long-running steps blocking debug UI | Medium | Timeout enforcement via existing retry/timeout module |
| Replay controller compatibility | Low | Recorded replay uses cached results, unaffected by executor changes |

## Acceptance Criteria Mapping

| Criteria | Implementation | Component |
|----------|---------------|-----------|
| Can set breakpoints on workflow steps | BreakpointManager → DebugHooks bridge | C4 |
| Execution pauses at breakpoints | beforeStep() → shouldStopAt() → pause | C4 |
| Variables view shows current step state | Real ExecutionContext → DAP scopes | C5 |
| Watch expressions evaluate correctly | Existing dot-notation against real state | (already works with real data) |
| Step Over advances to next step | executeSingleStep() + pause | C6 |
| Continue resumes to next breakpoint | DebugHooks.resume() → run to next match | C6 |
