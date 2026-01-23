# Implementation Plan: Workflow Step Execution Engine

**Feature**: Implement workflow step execution engine with action handlers
**Branch**: `140-implement-workflow-step-execution`
**Status**: Complete

## Summary

Build the core workflow step execution engine that transforms parsed YAML workflow definitions into actual executed actions. The engine supports four action types: `workspace.prepare` (git operations), `agent.invoke` (Claude Code CLI), `verification.check` (test/lint execution), and `pr.create` (GitHub PR creation). This is the missing piece that bridges the existing workflow parsing infrastructure with real-world execution.

## Technical Context

### Language & Framework
- **Language**: TypeScript (strict mode)
- **Runtime**: VS Code Extension (Node.js)
- **Build**: esbuild via VS Code extension bundler
- **Test Framework**: Vitest
- **Package Manager**: pnpm

### Key Dependencies
- `vscode` - VS Code extension API for terminal, task execution, and UI
- `yaml` - YAML parsing (already used for workflow parsing)
- `zod` - Schema validation (already in use)
- `child_process` - For direct CLI invocations

### Existing Infrastructure
- `WorkflowExecutor` class in `executor.ts` - orchestrates phase/step iteration with event emission
- `WorkflowTerminal` class in `terminal.ts` - VS Code terminal/task management
- `ExecutableWorkflow`, `WorkflowStep` types in `types.ts` - workflow data structures
- Workflow JSON Schema in `schemas/workflow.schema.json` - defines step properties like `uses`, `run`, `retry`

## Project Structure

```
packages/generacy-extension/src/views/local/runner/
├── executor.ts                 # Main executor (MODIFY - add action dispatch)
├── types.ts                    # Types (MODIFY - add action-specific types)
├── terminal.ts                 # Terminal manager (existing)
├── actions/                    # NEW: Action handlers directory
│   ├── index.ts               # Action registry & factory
│   ├── types.ts               # Shared action types
│   ├── base-action.ts         # Abstract base action class
│   ├── workspace-prepare.ts   # Git branch operations
│   ├── agent-invoke.ts        # Claude Code CLI invocation
│   ├── verification-check.ts  # Test/lint execution
│   └── pr-create.ts           # GitHub PR creation
├── interpolation/             # NEW: Variable interpolation
│   ├── index.ts               # Main interpolator
│   └── context.ts             # Execution context management
├── retry/                     # NEW: Retry logic
│   ├── index.ts               # Retry manager
│   └── strategies.ts          # Backoff strategies
└── debug-integration.ts       # NEW: Debug adapter hooks
```

## Implementation Phases

### Phase 1: Core Action Infrastructure
Create the foundational action handler system with base types and registry.

**Files to modify/create:**
- `actions/types.ts` - ActionHandler interface, ActionContext, ActionResult
- `actions/base-action.ts` - Abstract BaseAction class with common functionality
- `actions/index.ts` - Action registry and factory function
- `types.ts` - Extend WorkflowStep to include parsed action metadata

### Phase 2: Variable Interpolation Engine
Build the variable resolution system for `${inputs.*}` and `${steps.*}` patterns.

**Files to create:**
- `interpolation/context.ts` - ExecutionContext class tracking step outputs
- `interpolation/index.ts` - Variable interpolator with deep path support

**Variable patterns:**
- `${inputs.<name>}` - Workflow inputs
- `${steps.<stepId>.output}` - Step output (string)
- `${steps.<stepId>.output.<field>}` - Nested JSON field access
- `${env.<name>}` - Environment variables

### Phase 3: Action Handlers
Implement the four core action types.

**workspace.prepare** (`actions/workspace-prepare.ts`):
- Create and checkout git branch
- Uses `git` CLI via `child_process.exec`
- Captures branch name as output

**agent.invoke** (`actions/agent-invoke.ts`):
- Invoke Claude Code CLI directly
- Parse `--output-format json` response
- Handle streaming output for progress
- Capture structured JSON output for interpolation

**verification.check** (`actions/verification-check.ts`):
- Execute test/lint commands via shell
- Parse output for success/failure
- Support common test runners (vitest, jest, npm test)

**pr.create** (`actions/pr-create.ts`):
- Use `gh pr create` CLI command
- Set title, body, base branch from step inputs
- Return PR URL as output

### Phase 4: Retry & Timeout
Implement configurable retry with exponential backoff.

**Files to create:**
- `retry/strategies.ts` - Constant, linear, exponential backoff functions
- `retry/index.ts` - RetryManager wrapping action execution

**Configuration (from workflow YAML):**
```yaml
retry:
  max_attempts: 3
  delay: 10s
  backoff: exponential
  max_delay: 5m
```

### Phase 5: Executor Integration
Connect action handlers to the existing executor.

**Modify `executor.ts`:**
- Replace generic terminal execution with action dispatch
- Inject ExecutionContext for variable interpolation
- Wire up retry logic per step configuration
- Emit granular events for action lifecycle

### Phase 6: Debug Adapter Integration
Add step boundary hooks for the debug adapter.

**File to create:**
- `debug-integration.ts` - DebugHooks class

**Capabilities:**
- `beforeStep(step)` - Check for breakpoints, pause if needed
- `afterStep(step, result)` - Report completion, check continue/stop
- Step state inspection API

## Key Interfaces

### ActionHandler
```typescript
interface ActionHandler {
  readonly type: string;
  canHandle(step: WorkflowStep): boolean;
  execute(step: WorkflowStep, context: ActionContext): Promise<ActionResult>;
}
```

### ActionContext
```typescript
interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: WorkflowPhase;
  step: WorkflowStep;
  inputs: Record<string, unknown>;
  stepOutputs: Map<string, StepOutput>;
  env: Record<string, string>;
  workdir: string;
  signal: AbortSignal;
}
```

### ActionResult
```typescript
interface ActionResult {
  success: boolean;
  output: unknown;  // Structured JSON preferred
  error?: string;
  exitCode?: number;
  duration: number;
}
```

## Testing Strategy

### Unit Tests
- Variable interpolation with edge cases
- Retry strategy calculations
- Each action handler in isolation (mock child_process)

### Integration Tests
- Full workflow execution with mock CLI responses
- Error propagation and retry behavior
- Debug hooks with mock debug adapter

### Manual Testing
- Real workflow execution in VS Code
- Claude Code CLI integration (requires installation)
- GitHub PR creation (requires gh auth)

## Error Handling

| Error Type | Handling |
|------------|----------|
| Action not found | Fail with descriptive error |
| CLI not installed | Check before execution, helpful error message |
| Interpolation failure | Fail step with unresolved variable name |
| Timeout | Cancel action, report timeout in result |
| Non-zero exit | Check `continueOnError`, retry if configured |

## Dependencies Check

### Required CLI Tools
- `git` - Always available (VS Code workspace assumption)
- `gh` - GitHub CLI for PR operations
- `claude` - Claude Code CLI for agent invocation

### Installation Check Pattern
```typescript
async function checkCLI(cmd: string): Promise<boolean> {
  try {
    await exec(`${cmd} --version`);
    return true;
  } catch {
    return false;
  }
}
```

## Success Criteria Mapping

| Spec Criterion | Implementation |
|----------------|----------------|
| Execute 4-step workflow | All action handlers working |
| Correct step inputs | Variable interpolation engine |
| Structured JSON outputs | ActionResult.output parsing |
| Variable interpolation | `${steps.*}` pattern resolution |
| Timeout & retry | RetryManager with configurable backoff |
| Debug adapter integration | DebugHooks class with step boundaries |

---

*Generated by speckit*
