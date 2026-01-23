# Research: Workflow Step Execution Engine

## Technology Decisions

### 1. Action Handler Pattern

**Decision**: Use a registry-based action handler pattern with a common interface.

**Rationale**:
- Extensible - new action types can be added without modifying core executor
- Testable - each handler can be unit tested in isolation
- Type-safe - TypeScript interfaces ensure consistent contract
- Follows existing VS Code extension patterns (e.g., command handlers)

**Alternatives Considered**:
- **Switch statement dispatch**: Simpler but harder to extend, violates Open/Closed principle
- **Plugin system**: Over-engineered for 4 core actions, added complexity

### 2. CLI Invocation Strategy

**Decision**: Use Node.js `child_process.execFile` for CLI invocations.

**Rationale**:
- Direct control over process lifecycle (stdin, stdout, stderr)
- Ability to capture structured output (JSON from Claude Code CLI)
- Timeout and cancellation support via signals
- No terminal overhead for non-interactive commands

**Alternatives Considered**:
- **VS Code Terminal API**: No programmatic output capture, designed for user interaction
- **VS Code Task API**: Good for build tasks, but limited control over output parsing
- **Containerized execution**: Future work for cloud mode, overkill for local MVP

### 3. Variable Interpolation

**Decision**: String-based interpolation with JSON path resolution.

**Rationale**:
- Consistent with GitHub Actions syntax (`${{ }}` patterns)
- Supports nested field access (`${steps.build.output.artifacts[0]}`)
- Graceful fallback to string coercion for non-JSON outputs

**Implementation Pattern**:
```typescript
function interpolate(template: string, context: InterpolationContext): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, path) => {
    return resolvePathSafe(context, path);
  });
}
```

### 4. Retry with Exponential Backoff

**Decision**: Per-step configurable retry with exponential backoff as default.

**Rationale**:
- Different actions have different failure modes
- Network operations benefit from exponential backoff
- YAML schema already defines retry configuration

**Backoff Calculation**:
```typescript
function exponentialDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const delay = baseDelay * Math.pow(2, attempt - 1);
  return Math.min(delay, maxDelay);
}
```

### 5. Debug Integration

**Decision**: Step-boundary hooks with optional pause/inspect capability.

**Rationale**:
- Steps are atomic operations - no need for step-into
- Matches user mental model (each step is a logical unit)
- Minimal overhead when debugging is disabled

**Hook Points**:
- `beforeStep`: Check breakpoints, pause execution
- `afterStep`: Report result, allow inspection
- `onError`: Report failure before retry/propagation

## Implementation Patterns

### Command Execution Pattern
```typescript
interface CommandExecution {
  exec(cmd: string[], options: ExecOptions): Promise<CommandResult>;
}

class ChildProcessExecution implements CommandExecution {
  async exec(cmd: string[], options: ExecOptions): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const proc = execFile(cmd[0], cmd.slice(1), {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeout,
        signal: options.signal,
      }, (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (error as NodeJS.ErrnoException).code ?? 1 : 0,
          stdout,
          stderr,
        });
      });
    });
  }
}
```

### Output Parsing Pattern
Claude Code CLI outputs JSON with `--output-format json`:
```json
{
  "type": "complete",
  "data": {
    "summary": "Created feature X",
    "filesModified": ["src/feature.ts"]
  }
}
```

Parse and validate:
```typescript
const output = JSON.parse(stdout);
if (output.type === 'complete') {
  return { success: true, output: output.data };
}
```

### Action Context Threading
```typescript
class ExecutionContextManager {
  private stepOutputs = new Map<string, StepOutput>();

  setStepOutput(stepId: string, output: StepOutput): void {
    this.stepOutputs.set(stepId, output);
  }

  resolveVariable(path: string): unknown {
    const [type, ...rest] = path.split('.');
    if (type === 'steps') {
      const [stepId, ...fieldPath] = rest;
      const output = this.stepOutputs.get(stepId);
      return resolvePath(output, fieldPath);
    }
    // Handle other types: inputs, env
  }
}
```

## Key Sources/References

### VS Code Extension API
- [Task API](https://code.visualstudio.com/api/extension-guides/task-provider): Used for some step types
- [Terminal API](https://code.visualstudio.com/api/references/vscode-api#Terminal): For interactive commands

### Claude Code CLI
- Output format: JSON streaming with `--output-format json`
- Headless mode: `--headless` for non-interactive execution
- Print level: `--print all` for full output capture

### GitHub CLI
- PR creation: `gh pr create --title "..." --body "..." --base main`
- Authentication: Requires `gh auth login` prior to use

### Node.js Child Process
- [execFile documentation](https://nodejs.org/api/child_process.html#child_processexecfilefile-args-options-callback)
- Timeout handling via `timeout` option
- Cancellation via `AbortSignal`

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Claude Code CLI not installed | Medium | Blocks agent.invoke | Pre-check with helpful error message |
| gh CLI not authenticated | Medium | Blocks pr.create | Pre-check, link to auth docs |
| JSON parse failure | Low | Step fails | Fallback to string output |
| Timeout too short | Medium | False failures | Configurable per-step |

---

*Generated by speckit*
