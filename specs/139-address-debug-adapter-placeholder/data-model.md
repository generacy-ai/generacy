# Data Model: Debug Adapter Enhancements

## Core Entities

### LaunchRequestArguments (Enhanced)

```typescript
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  workflow: string;           // Path to workflow YAML file
  dryRun?: boolean;           // Dry run mode (existing)
  stopOnEntry?: boolean;      // Pause at first step (existing)
  env?: Record<string, string>; // Environment variables (existing)
  pauseOnError?: boolean;     // NEW: Pause on step error instead of terminating
}
```

### RuntimeMode (Enhanced)

```typescript
type RuntimeMode = 'run' | 'step' | 'pause' | 'stepOut';
// Added 'stepOut' mode to track step-out in progress
```

### StepOutState (New)

```typescript
interface StepOutState {
  active: boolean;           // Whether step-out is in progress
  targetPhaseIndex: number;  // Phase index we're stepping out of
}
```

### NestedVariableEntry (New)

```typescript
interface NestedVariableEntry {
  value: unknown;            // The actual object/array value
  depth: number;             // Current expansion depth (max 1)
}
```

### ErrorPauseState (New)

```typescript
interface ErrorPauseState {
  paused: boolean;           // Currently paused on error
  phaseName: string;         // Phase where error occurred
  stepName: string;          // Step where error occurred
  error: string;             // Error message
}
```

## Type Definitions

### WorkflowDebugRuntime (Enhanced Properties)

```typescript
class WorkflowDebugRuntime {
  // Existing properties...

  // New properties for step-out
  private stepOutState: StepOutState = { active: false, targetPhaseIndex: -1 };

  // New properties for error pause
  private pauseOnError: boolean = false;
  private errorPauseState: ErrorPauseState | null = null;
}
```

### DebugExecutionState (Enhanced Properties)

```typescript
class DebugExecutionState {
  // Existing properties...

  // New properties for nested variable references
  private nestedVariableRefs: Map<number, NestedVariableEntry> = new Map();
  private nextVariableRef: number = 10000; // Start high to avoid conflicts
}
```

## Validation Rules

### Launch Configuration Validation

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| workflow | string | Yes | - | Must be valid file path |
| stopOnEntry | boolean | No | true | - |
| pauseOnError | boolean | No | false | - |
| env | object | No | {} | Keys must be valid env var names |

### Variable Reference Validation

| Condition | Result |
|-----------|--------|
| variablesReference === 0 | Not expandable |
| variablesReference > 0 | Expandable (object/array) |
| Reference not in map | Return empty array |

## Relationships

```
LaunchRequestArguments
    │
    ├──► WorkflowDebugRuntime (uses pauseOnError)
    │         │
    │         ├──► StepOutState (tracks phase boundary)
    │         │
    │         └──► ErrorPauseState (tracks error pause)
    │
    └──► DebugExecutionState
              │
              └──► NestedVariableEntry (variable expansion)
```

## State Transitions

### Step-Out State Machine

```
[Initial] ──stepOut()──► [StepOutActive]
                              │
                   ┌──────────┴──────────┐
                   ▼                      ▼
            [PhaseComplete]         [PhaseBoundary]
                   │                      │
                   ▼                      ▼
            [StepOutActive]          [Paused]
              (continue)
```

### Error Pause State Machine

```
[Running] ──error──► [ErrorCheck]
                          │
               ┌──────────┴──────────┐
               ▼                      ▼
        [pauseOnError=false]   [pauseOnError=true]
               │                      │
               ▼                      ▼
         [Terminated]            [ErrorPaused]
                                      │
                           ┌──────────┴──────────┐
                           ▼                      ▼
                       [skip()]              [abort()]
                           │                      │
                           ▼                      ▼
                     [NextStep]             [Terminated]
```

## DAP Message Types Used

### Outgoing Events

| Event | When | Body Fields |
|-------|------|-------------|
| stopped | Step-out at phase boundary | `reason: 'step'`, `threadId: 1` |
| stopped | Error pause | `reason: 'exception'`, `description`, `threadId: 1` |
| output | Step output | `category: 'stdout'`, `output` |
| terminated | Workflow ends | (none) |

### Incoming Requests (Error Recovery)

| Request | Handler | Purpose |
|---------|---------|---------|
| continue | handleContinue | Skip failed step, continue |
| disconnect | handleDisconnect | Abort execution |
