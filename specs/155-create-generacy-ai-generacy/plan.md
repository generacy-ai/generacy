# Implementation Plan: @generacy-ai/generacy npm package

**Feature**: Create @generacy-ai/generacy npm package for headless workflow execution
**Branch**: `155-create-generacy-ai-generacy`
**Status**: Complete

## Summary

Create a publishable npm package (`@generacy-ai/generacy`) that provides headless workflow execution capabilities for running Generacy workflows in containers without VS Code. This implementation extracts the existing workflow runner from the VS Code extension into a shared `@generacy-ai/workflow-engine` package, then builds the CLI package on top of it.

## Technical Context

| Aspect | Details |
|--------|---------|
| **Language** | TypeScript 5.6+ |
| **Runtime** | Node.js 20+ |
| **Module System** | ES Modules (`"type": "module"`) |
| **Build Tool** | TypeScript compiler (tsc) |
| **Test Framework** | Vitest |
| **Linting** | ESLint |
| **CLI Framework** | Commander.js |
| **HTTP Client** | Native fetch API |
| **Logging** | Pino |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    @generacy-ai/generacy (CLI)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  │
│  │  run cmd    │  │  worker cmd │  │  agent cmd  │                  │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                  │
│         │                │                │                          │
│  ┌──────┴────────────────┴────────────────┴──────┐                  │
│  │           Orchestrator Client                  │                  │
│  │        (REST API + Polling)                    │                  │
│  └──────────────────┬────────────────────────────┘                  │
│                     │                                                │
│  ┌──────────────────┴────────────────────────────┐                  │
│  │           Agency Integration                   │                  │
│  │    (Subprocess stdio / Network HTTP)          │                  │
│  └───────────────────────────────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              @generacy-ai/workflow-engine (Shared)                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │ Workflow Engine │  │  Action System  │  │  Retry System   │      │
│  │   (executor)    │  │   (registry)    │  │   (backoff)     │      │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘      │
│           │                    │                    │                │
│  ┌────────┴────────────────────┴────────────────────┴───────┐       │
│  │                 Interpolation Engine                      │       │
│  │            (${inputs.*}, ${steps.*}, ${env.*})           │       │
│  └──────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              VS Code Extension (Existing)                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐      │
│  │  Terminal UI    │  │  Output Channel │  │  Debug Adapter  │      │
│  │  (VS Code)      │  │   (VS Code)     │  │   (VS Code)     │      │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘      │
│                              │                                       │
│                              ▼                                       │
│             imports @generacy-ai/workflow-engine                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Project Structure

### Package 1: @generacy-ai/workflow-engine

```
packages/workflow-engine/
├── src/
│   ├── index.ts                    # Public exports
│   ├── executor/
│   │   ├── index.ts               # WorkflowExecutor class
│   │   ├── types.ts               # Execution types & interfaces
│   │   └── events.ts              # Event emission system
│   ├── actions/
│   │   ├── index.ts               # Action registry & factory
│   │   ├── types.ts               # ActionHandler interface
│   │   ├── base-action.ts         # Abstract base class
│   │   └── builtin/
│   │       ├── workspace-prepare.ts  # Git operations
│   │       ├── agent-invoke.ts       # Claude CLI invocation
│   │       ├── verification-check.ts # Test/lint execution
│   │       ├── pr-create.ts          # GitHub PR creation
│   │       └── shell.ts              # Generic shell command
│   ├── interpolation/
│   │   ├── index.ts               # Template engine
│   │   └── context.ts             # ExecutionContext class
│   ├── retry/
│   │   ├── index.ts               # RetryManager class
│   │   └── strategies.ts          # Backoff algorithms
│   └── loader/
│       ├── index.ts               # Workflow loader
│       ├── schema.ts              # Workflow JSON schema
│       └── validator.ts           # Zod validation
├── package.json
├── tsconfig.json
└── README.md
```

### Package 2: @generacy-ai/generacy (CLI)

```
packages/generacy/
├── src/
│   ├── index.ts                   # Library exports
│   ├── cli/
│   │   ├── index.ts              # CLI entry point (Commander)
│   │   ├── commands/
│   │   │   ├── run.ts            # 'run' command
│   │   │   ├── worker.ts         # 'worker' command
│   │   │   └── agent.ts          # 'agent' command
│   │   └── utils/
│   │       ├── logger.ts         # Pino logger setup
│   │       └── config.ts         # CLI config resolution
│   ├── orchestrator/
│   │   ├── client.ts             # REST API client
│   │   ├── heartbeat.ts          # Health/heartbeat manager
│   │   ├── job-handler.ts        # Job polling & processing
│   │   └── types.ts              # API types (from Zod schemas)
│   ├── agency/
│   │   ├── index.ts              # Agency connection manager
│   │   ├── subprocess.ts         # Subprocess/stdio mode
│   │   └── network.ts            # Network/HTTP mode
│   └── health/
│       └── server.ts             # Health check HTTP server
├── bin/
│   └── generacy.js               # CLI binary entry
├── package.json
├── tsconfig.json
└── README.md
```

## Implementation Approach

### Phase 1: Extract Workflow Engine

Extract the existing workflow runner from `packages/generacy-extension/src/views/local/runner/` into `packages/workflow-engine/`:

1. **Copy core files** - executor, types, actions, interpolation, retry
2. **Remove VS Code dependencies** - Replace `vscode.CancellationTokenSource` with `AbortController`
3. **Abstract logger interface** - Replace VS Code output channel with `Logger` interface
4. **Export public API** - Expose `WorkflowExecutor`, action registry, types

**Key Abstraction Pattern:**
```typescript
// Logger interface (replaces VS Code OutputChannel)
interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

// ActionContext interface (already portable)
interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: WorkflowPhase;
  step: WorkflowStep;
  inputs: Record<string, unknown>;
  stepOutputs: Map<string, StepOutput>;
  env: Record<string, string>;
  workdir: string;
  signal: AbortSignal;  // Standard web API
  logger: Logger;
}
```

### Phase 2: Build CLI Package

1. **CLI framework** - Commander.js for command parsing
2. **Run command** - Direct workflow execution from YAML file
3. **Worker command** - Connect to orchestrator, poll for jobs
4. **Agent command** - Worker + Agency MCP integration

### Phase 3: Orchestrator Client

Build REST API client based on existing `packages/orchestrator/src/types/api.ts`:

```typescript
class OrchestratorClient {
  constructor(baseUrl: string, options?: ClientOptions);

  // Registration
  register(workerId: string, capabilities: string[]): Promise<void>;
  unregister(): Promise<void>;

  // Heartbeat
  sendHeartbeat(): Promise<void>;

  // Job polling
  pollForJob(): Promise<Job | null>;
  updateJobStatus(jobId: string, status: JobStatus): Promise<void>;
  reportJobResult(jobId: string, result: JobResult): Promise<void>;
}
```

### Phase 4: Agency Integration

Support dual connection modes:

```typescript
interface AgencyConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

// Subprocess mode (MCP default)
class SubprocessAgency implements AgencyConnection {
  // Launch Agency as subprocess, communicate via stdio
}

// Network mode (HTTP transport)
class NetworkAgency implements AgencyConnection {
  // Connect to Agency running as HTTP service
}
```

## Dependencies

### @generacy-ai/workflow-engine

```json
{
  "dependencies": {
    "yaml": "^2.4.0",
    "zod": "^3.23.0"
  }
}
```

### @generacy-ai/generacy

```json
{
  "dependencies": {
    "@generacy-ai/workflow-engine": "workspace:*",
    "commander": "^12.0.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0"
  }
}
```

## API Design

### WorkflowEngine Public API

```typescript
// Main executor
export class WorkflowExecutor {
  constructor(options: ExecutorOptions);
  execute(workflow: ExecutableWorkflow): Promise<ExecutionResult>;
  cancel(): void;
  on(event: ExecutorEvent, handler: EventHandler): void;
}

// Workflow loading
export function loadWorkflow(path: string): Promise<ExecutableWorkflow>;
export function validateWorkflow(workflow: unknown): ExecutableWorkflow;

// Action registration
export function registerActionHandler(handler: ActionHandler): void;
export function getActionHandler(step: WorkflowStep): ActionHandler | undefined;

// Types
export type { ExecutableWorkflow, WorkflowPhase, WorkflowStep };
export type { ActionHandler, ActionContext, ActionResult };
export type { ExecutionResult, ExecutionStatus };
```

### CLI Public API

```typescript
// Programmatic usage (library mode)
export { WorkflowRunner } from './runner';
export { OrchestratorClient } from './orchestrator/client';
export { AgencyConnection, SubprocessAgency, NetworkAgency } from './agency';
```

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Module format | ES Modules | Aligns with orchestrator, modern Node.js |
| CLI framework | Commander.js | Simple, well-documented, tree-shakeable |
| HTTP client | Native fetch | No dependencies, Node 20+ built-in |
| Logging | Pino | Fast, JSON-native, structured logging |
| Orchestrator protocol | REST + polling | Uses existing API, simpler than WebSocket |
| Agency connection | Dual mode | Flexibility for different deployment scenarios |
| Cancellation | AbortController | Web standard, already used in extension |

## Testing Strategy

1. **Unit tests** - Workflow engine components (executor, actions, interpolation)
2. **Integration tests** - CLI commands with mock orchestrator
3. **E2E tests** - Full workflow execution with sample workflows

## Migration Path for VS Code Extension

After extracting the workflow engine:

1. Update extension's `package.json` to depend on `@generacy-ai/workflow-engine`
2. Create VS Code adapter layer for terminal/output/debug
3. Replace direct imports with engine imports
4. Remove duplicated code from extension

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking extension during extraction | High | Incremental extraction, feature flag |
| Orchestrator API changes | Medium | Version pinning, adapter layer |
| Agency connection failures | Medium | Fallback modes, retry logic |
| Performance overhead from abstraction | Low | Profile-guided optimization |

## File Mapping (Extension → Engine)

| Extension Path | Engine Path | Notes |
|---------------|-------------|-------|
| `runner/executor.ts` | `executor/index.ts` | Remove VS Code deps |
| `runner/types.ts` | `executor/types.ts` | Keep as-is |
| `runner/actions/*` | `actions/*` | Keep action registry pattern |
| `runner/interpolation/*` | `interpolation/*` | Pure logic, no changes |
| `runner/retry/*` | `retry/*` | Pure logic, no changes |
| `runner/terminal.ts` | N/A | VS Code specific, not extracted |
| `runner/output-channel.ts` | N/A | VS Code specific, not extracted |
| `runner/debug-integration.ts` | N/A | VS Code specific, not extracted |

## Success Criteria

1. ✅ Package publishes to npm as @generacy-ai/generacy
2. ✅ `npx @generacy-ai/generacy --help` shows available commands
3. ✅ `npx @generacy-ai/generacy run workflow.yaml` executes a workflow
4. ✅ `npx @generacy-ai/generacy worker` connects to orchestrator
5. ✅ VS Code extension continues working after extraction
6. ✅ No VS Code dependencies in extracted packages
7. ✅ Health check endpoint available at configurable port
8. ✅ Graceful shutdown on SIGTERM/SIGINT

---

*Generated by speckit*
