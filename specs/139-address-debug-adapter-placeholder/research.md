# Research: Debug Adapter Placeholder Implementations

## Technology Decisions

### 1. Debug Adapter Protocol (DAP) Conformance

**Decision**: Follow standard DAP patterns for all implementations

**Key DAP Concepts Used**:
- **Stopped events**: `reason` field values ('step', 'breakpoint', 'exception', 'pause')
- **Variable references**: Non-zero values indicate expandable containers
- **Stack frames**: Hierarchical execution context (step → phase → workflow)
- **Exception handling**: `supportsExceptionInfoRequest` capability

**Source**: [VS Code DAP Specification](https://microsoft.github.io/debug-adapter-protocol/specification)

### 2. Step-Out Implementation Pattern

**Alternatives Considered**:

| Approach | Description | Chosen |
|----------|-------------|--------|
| Phase boundary tracking | Track target phase, pause at first step of next phase | ✅ |
| Call stack pop | Pop to parent frame in nested workflows | ❌ (no nesting yet) |
| Run to completion | Same as continue | ❌ (not useful) |

**Rationale**: Phase-based stepping aligns with workflow structure where phases are the primary organizational unit. This provides meaningful "step out" semantics for workflow debugging.

**Implementation Pattern**:
```typescript
// Set step-out target as "end of current phase"
this.stepOutTargetPhase = this.currentPhaseIndex;
this.mode = 'run';
// In execution loop, check if phase boundary crossed and pause
```

### 3. Variable Expansion Strategy

**Alternatives Considered**:

| Approach | Description | Chosen |
|----------|-------------|--------|
| Full recursive expansion | Expand all levels with depth limit | ❌ |
| Single level expansion | Expand immediate children only | ✅ |
| No expansion (current) | Require evaluate expressions | ❌ |

**Rationale**: Single level expansion provides 80% of the utility with minimal complexity. Deep objects can still be inspected via the evaluate expression feature.

**DAP Variable Reference Pattern**:
```typescript
// Non-zero variablesReference indicates expandable
{
  name: "config",
  value: "Object",
  type: "object",
  variablesReference: 1001,  // Non-zero = can expand
  namedVariables: 3
}
```

### 4. Error Handling Strategy

**Current Behavior**:
- Step fails → workflow terminates (unless `continueOnError: true`)
- No user intervention possible

**New Behavior**:
- Add `pauseOnError` launch configuration option
- When error occurs and `pauseOnError` is true:
  1. Emit `stopped` event with `reason: 'exception'`
  2. User sees error in call stack
  3. User can: skip step, or abort execution
- Retry functionality deferred (requires variable modification support)

**DAP Exception Event Pattern**:
```typescript
this.sendEvent({
  type: 'event',
  event: 'stopped',
  body: {
    reason: 'exception',
    description: error.message,
    threadId: 1,
    allThreadsStopped: true
  }
});
```

## Implementation Patterns

### Pattern 1: Phase Boundary Detection

```typescript
// In runtime.ts execution loop
if (this.stepOutTargetPhase !== undefined &&
    phaseIndex > this.stepOutTargetPhase) {
  // Crossed phase boundary - pause
  this.mode = 'pause';
  this.stepOutTargetPhase = undefined;
  this.emitEvent({ type: 'stopped', reason: 'step' });
  await this.waitForContinue();
}
```

### Pattern 2: Nested Variable References

```typescript
// In state.ts
private nestedRefs = new Map<number, { parent: unknown; key: string | number }>();

createChildReference(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const ref = ++this.refCounter;
  this.nestedRefs.set(ref, { parent: null, key: '', value });
  return ref;
}

getNestedVariables(ref: number): DebugVariable[] {
  const entry = this.nestedRefs.get(ref);
  if (!entry) return [];
  // Return children of the stored value
}
```

### Pattern 3: Error Pause Flow

```typescript
// In runtime.ts
try {
  await terminal.executeStepWithCapture(step, options);
} catch (error) {
  if (this.pauseOnError) {
    this.state.markStepError(phaseName, stepName, error);
    this.emitEvent({ type: 'stopped', reason: 'exception' });
    await this.waitForContinue(); // User decides: skip or abort
  } else {
    throw error; // Original behavior
  }
}
```

## Key References

1. **DAP Specification**: https://microsoft.github.io/debug-adapter-protocol/specification
2. **VS Code Debug Extension Guide**: https://code.visualstudio.com/api/extension-guides/debugger-extension
3. **@vscode/debugprotocol types**: Installed in project

## Testing Considerations

### Test Scenarios for Step-Out

1. Step-out from middle of phase → pause at first step of next phase
2. Step-out from last step of phase → pause at first step of next phase
3. Step-out from last phase → workflow completes normally
4. Step-out then step-next → continues normally

### Test Scenarios for Variable Expansion

1. Expand simple object → shows key-value pairs
2. Expand array → shows indexed elements
3. Expand nested object → child references are non-zero but not expandable (1 level)
4. Primitive values → variablesReference is 0

### Test Scenarios for Error Pause

1. Step fails with pauseOnError=true → stopped event with exception reason
2. Skip step after error → continues to next step
3. Abort after error → workflow ends
4. Step fails with pauseOnError=false → original termination behavior
