# Research: Debug Adapter Integration

## Technology Decisions

### 1. Event Bridge Pattern (over Direct Coupling)

**Decision**: Use a mediator/bridge class to sync executor events to debug state.

**Rationale**: The executor (`WorkflowExecutor`) and debug state (`DebugExecutionState`) are both singletons with their own event systems. Rather than making the executor import and directly update debug state (tight coupling), an `ExecutorEventBridge` subscribes to executor events and translates them to state updates.

**Alternatives Considered**:
- **Direct coupling**: Executor calls `DebugExecutionState.setVariable()` directly. Rejected because it creates a dependency from runner → debugger modules.
- **Observer pattern on state**: State subscribes to executor. Rejected because state shouldn't know about the executor's event types.
- **Shared event bus**: A global event emitter both subscribe to. Rejected as over-engineered for two known participants.

### 2. Single-Step Executor API (over Full Session Takeover)

**Decision**: Add `executeSingleStep()` to `WorkflowExecutor` rather than having the debug session drive the executor's internal loop.

**Rationale**: The executor's `execute()` method manages the full workflow lifecycle (phases, conditions, error handling). The debug session needs fine-grained control — execute one step, then pause for user interaction. Exposing a single-step API lets the session control the pace while the executor handles the action pipeline.

**Alternatives Considered**:
- **Coroutine/generator pattern**: Make `execute()` a generator that yields after each step. Rejected because TypeScript async generators add complexity and the executor's internal state management isn't designed for this.
- **Full delegation**: Hand the workflow to the executor and let debug hooks handle all pausing. This is how the hooks already work, but it doesn't give the session control over which step to execute next (needed for Step Over vs Step Out behavior).

### 3. BreakpointManager as Source of Truth (over DebugHooks Breakpoints)

**Decision**: Wire `DebugHooks` to delegate breakpoint matching to the existing `BreakpointManager`.

**Rationale**: `BreakpointManager` already has condition evaluation, hit counts, log points, and DAP-protocol breakpoint management. `DebugHooks` has a simpler `Breakpoint` interface. Rather than duplicating logic, `DebugHooks.findMatchingBreakpoint()` should delegate to `BreakpointManager.shouldStopAt()`.

**Alternatives Considered**:
- **Keep both systems**: DebugHooks has its own breakpoint list for executor-level breaks, BreakpointManager for DAP-level. Rejected because users set breakpoints via the DAP UI (BreakpointManager), so DebugHooks' list would be empty.
- **Replace DebugHooks entirely**: Remove DebugHooks and have the executor directly use BreakpointManager. Rejected because DebugHooks provides the pause/resume Promise gate that the executor needs.

## Implementation Patterns

### Promise-Based Pause Gate

The executor uses a Promise gate pattern for pausing:

```typescript
// In DebugHooks
private pausePromise: Promise<void> | null = null;
private resumeCallback: (() => void) | null = null;

async beforeStep(state: StepState): Promise<void> {
  if (shouldPause) {
    this.pausePromise = new Promise(resolve => {
      this.resumeCallback = resolve;
    });
    await this.pausePromise;
  }
}

resume(): void {
  this.resumeCallback?.();
  this.pausePromise = null;
}
```

This pattern is already implemented in `debug-integration.ts` and works well for single-threaded async execution.

### DAP Scope-to-Variable Mapping

DAP represents variables in a hierarchy: Scopes → Variables → Child Variables. Each scope gets a `variablesReference` number. When VS Code requests variables for a reference, we return the variables in that scope.

```
Scopes Request → [
  { name: "Inputs", variablesReference: 1 },
  { name: "Outputs", variablesReference: 2 },
  { name: "Workflow", variablesReference: 3 }
]

Variables Request (ref=1) → [
  { name: "prompt", value: "hello", type: "string" },
  { name: "model", value: "claude-3", type: "string" }
]

Variables Request (ref=2) → [
  { name: "result", value: "{...}", type: "object", variablesReference: 4 },
  { name: "exitCode", value: "0", type: "number" }
]
```

### Executor Event Types

The executor emits these events that the bridge needs to handle:

| Event Type | Data | Bridge Action |
|-----------|------|---------------|
| `execution:start` | workflowName | `state.startWorkflow()` |
| `phase:start` | phaseName | `state.startPhase()` |
| `step:start` | stepName, inputs | `state.startStep()`, set input variables |
| `step:complete` | stepName, output, duration | `state.completeStep()`, set output variables |
| `step:error` | stepName, error | `state.fail()`, feed to ErrorAnalysis |
| `phase:complete` | phaseName | `state.completePhase()` |
| `execution:complete` | result | `state.complete()` |

## Key Sources

- VS Code Debug Adapter Protocol: https://microsoft.github.io/debug-adapter-protocol/
- Existing `DebugHooks` implementation: `runner/debug-integration.ts`
- Existing `BreakpointManager`: `debugger/breakpoints.ts`
- Existing `DebugExecutionState`: `debug/state.ts`
- Related plan #147: `specs/147-complete-workflow-step-execution/plan.md`
- Related plan #139: `specs/139-address-debug-adapter-placeholder/plan.md`
