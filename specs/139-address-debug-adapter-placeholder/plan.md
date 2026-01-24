# Implementation Plan: Address Debug Adapter Placeholder Implementations

**Feature**: Complete placeholder implementations in the debug adapter
**Branch**: `139-address-debug-adapter-placeholder`
**Status**: Complete

## Summary

This feature addresses incomplete placeholder implementations in the Generacy VS Code extension's debug adapter. The debug adapter provides step-through debugging for Generacy workflow YAML files using the VS Code Debug Adapter Protocol (DAP). Several methods have placeholder behavior that needs proper implementation.

## Technical Context

- **Language**: TypeScript
- **Framework**: VS Code Extension API, Debug Adapter Protocol (DAP)
- **Package**: `packages/generacy-extension`
- **Key Dependencies**: `@vscode/debugprotocol`, `yaml`

## Current State Analysis

### Placeholder Locations Identified

1. **`runtime.ts:stepIn()`** (line 188-189)
   - Currently: `this.stepNext()` - delegates to step-next
   - Impact: No distinction between step-over and step-into

2. **`runtime.ts:stepOut()`** (line 195-203)
   - Currently: Just switches to 'run' mode
   - Impact: Doesn't pause at phase boundaries

3. **`state.ts:createChildReference()`** (line 565-569)
   - Currently: Returns 0 (no expansion)
   - Impact: Cannot inspect nested objects/arrays in Variables panel

4. **Error handling in `runtime.ts:runExecution()`** (lines 454-477)
   - Currently: Terminates workflow on error unless `continueOnError` is true
   - Impact: No interactive error recovery options

## Design Decisions

Based on the codebase patterns and pragmatic considerations for addressing placeholders:

### D1: Step-Into Behavior
**Decision**: Keep current behavior (step-into = step-next) for now
**Rationale**: The current workflow structure doesn't support nested workflow calls. When/if `call-workflow` actions are added, step-into can be enhanced. This is consistent with the placeholder comment.

### D2: Step-Out Behavior
**Decision**: Implement proper phase-boundary pausing
**Approach**: Track phase boundaries and pause at the first step of the next phase
**Implementation**: Add `completeCurrentPhase` flag to runtime state

### D3: Nested Variable Inspection
**Decision**: Implement partial expansion (one level deep)
**Rationale**: Provides useful debugging capability without complexity of deep recursion. Users can still use evaluate expressions for deeper inspection.

### D4: Error Recovery
**Decision**: Add pause-on-error option with skip/abort capabilities
**Rationale**: Interactive retry requires variable modification which needs more infrastructure. Skip/abort provides immediate value.

## Project Structure

```
packages/generacy-extension/src/debug/
├── adapter.ts          # Debug adapter entry point (no changes)
├── protocol.ts         # DAP message handlers (minor error event enhancement)
├── runtime.ts          # Workflow execution runtime (main changes)
├── state.ts            # Execution state tracking (variable expansion)
├── index.ts            # Exports (no changes)
└── __tests__/
    ├── adapter.test.ts # Existing tests
    ├── protocol.test.ts
    ├── runtime.test.ts # Add tests for new behavior
    └── state.test.ts   # Add tests for variable expansion
```

## Implementation Components

### Component 1: Step-Out Phase Boundary Tracking
**Files**: `runtime.ts`
**Changes**:
- Add `stepOutTarget` property to track target phase boundary
- Modify `stepOut()` to set target and continue execution
- Modify execution loop to check for phase boundary and pause

### Component 2: Nested Variable Expansion
**Files**: `state.ts`
**Changes**:
- Implement `createChildReference()` to create proper variable references
- Add `nestedVariableReferences` map to track nested object references
- Implement `getNestedVariables()` to return children of complex values
- Limit expansion depth to 1 level

### Component 3: Error Pause Support
**Files**: `runtime.ts`, `protocol.ts`
**Changes**:
- Add `pauseOnError` launch configuration option
- When step fails and `pauseOnError` is true, emit stopped event with reason 'exception'
- Add `skipStep()` method to skip failed step and continue
- Protocol handler sends exception event with skip capability

### Component 4: Test Updates
**Files**: `__tests__/runtime.test.ts`, `__tests__/state.test.ts`
**Changes**:
- Add tests for step-out phase boundary behavior
- Add tests for nested variable expansion
- Add tests for error pause functionality

## Constitution Check

No constitution.md found in `.specify/memory/`. Standard practices apply.

## Dependencies

No new dependencies required. Uses existing:
- `@vscode/debugprotocol` - DAP types
- `vscode` - Extension API
- `yaml` - Workflow parsing

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing debug functionality | Low | High | Comprehensive test coverage, preserve existing behavior as defaults |
| Variable expansion performance | Low | Medium | Limit to 1 level depth, lazy loading |
| Step-out edge cases at workflow end | Medium | Low | Handle gracefully by completing workflow |

## Success Metrics

- All placeholder comments addressed with proper implementations
- Step-out pauses at next phase boundary correctly
- Variables panel shows one level of nested object expansion
- Pause-on-error allows skip/abort of failed steps
- All existing tests pass, new tests cover new functionality
