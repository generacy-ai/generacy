# Research: Complete Workflow Step Execution Engine

## Technology Decisions

### 1. Action Handler Pattern

**Decision**: Use a registry-based action handler pattern with BaseAction inheritance.

**Rationale**:
- Extensibility: New action types can be added by implementing `ActionHandler` interface
- Separation of concerns: Each action type is encapsulated in its own class
- Testability: Handlers can be tested in isolation
- Dynamic dispatch: `getActionHandler()` finds the right handler based on step configuration

**Alternatives Considered**:
- Switch statement dispatch: Less extensible, harder to test
- Strategy pattern without registry: Harder to discover available actions

### 2. CLI Execution via spawn

**Decision**: Use Node.js `spawn` instead of `exec` for command execution.

**Rationale**:
- Stream-based output capture (no buffer limits)
- Better control over child process lifecycle
- Supports abort signals for cancellation
- Separate stdout/stderr streams

**Alternatives Considered**:
- `exec`: Buffer size limits, less control
- `execFile`: Similar to spawn but with shell interpretation issues

### 3. Variable Interpolation

**Decision**: Custom interpolation with `${path.to.value}` syntax.

**Rationale**:
- Compatible with GitHub Actions style
- Supports nested paths (`steps.build.output.version`)
- Type-safe resolution through `ExecutionContext`

**Implementation Pattern**:
```typescript
// Interpolation supports:
${inputs.issueNumber}        // Workflow inputs
${steps.stepId.output}       // Previous step outputs
${steps.stepId.exitCode}     // Exit codes
${env.VARIABLE}              // Environment variables
```

### 4. Retry with Exponential Backoff

**Decision**: Configurable retry with multiple backoff strategies.

**Rationale**:
- Transient failures are common with external CLIs
- Exponential backoff prevents overwhelming services
- Jitter prevents thundering herd

**Strategies Implemented**:
- `constant`: Fixed delay between retries
- `linear`: Delay increases linearly
- `exponential`: Delay doubles each retry (default)

### 5. Debug Integration

**Decision**: Separate debug hooks system that can be enabled/disabled.

**Rationale**:
- Zero overhead when debugging is disabled
- Clean separation from main execution logic
- Supports DAP (Debug Adapter Protocol) integration

## Implementation Patterns

### Action Handler Lifecycle

```
Step → parseActionType() → getActionHandler() → handler.execute()
                                                    ↓
                                         executeInternal() → CLI call
                                                    ↓
                                         ActionResult → storeStepOutput()
```

### Error Handling Chain

```
BaseAction.execute()     → catches and wraps errors
  ↓
RetryManager             → retries on failure
  ↓
WorkflowExecutor         → handles step failures
  ↓
ExecutionResult          → aggregates phase/step results
```

### Cancellation Flow

```
CancellationTokenSource → AbortController → spawn signal → process.kill()
                       ↘                  ↘
                        DebugHooks resume    RetryManager abort
```

## Key Sources/References

1. **VS Code Extension API**
   - `vscode.CancellationTokenSource` for cancellation
   - `vscode.Disposable` pattern for resource cleanup

2. **Node.js child_process**
   - `spawn()` for streaming output
   - `AbortSignal` support in Node.js 15+

3. **Claude Code CLI**
   - `--output-format json` for structured output
   - `--print all` for complete conversation capture
   - `--max-turns` for limiting agent iterations

4. **GitHub CLI (gh)**
   - `gh pr create --json` for structured PR data
   - `gh pr view` for existing PR lookup

## Performance Considerations

1. **Lazy Handler Registration**
   - Handlers registered on first use via `registerBuiltinActions()`
   - Avoids import overhead when runner not used

2. **Stream-based Output**
   - No memory accumulation for large outputs
   - Truncation handled by output channel

3. **Conditional Debug Hooks**
   - `isEnabled()` check before hook operations
   - No Promise allocation when disabled

## Security Considerations

1. **Environment Variable Isolation**
   - Step env merged, not inherited globally
   - `mergeEnv()` creates new object per action

2. **Command Injection Prevention**
   - `spawn()` with array args, not string
   - Shell mode only for explicit shell actions

3. **Timeout Enforcement**
   - Prevents runaway processes
   - SIGTERM with cleanup handling
