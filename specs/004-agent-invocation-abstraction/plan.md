# Implementation Plan: Agent Invocation Abstraction

**Feature**: Agent invocation abstraction layer for multi-platform support
**Branch**: `004-agent-invocation-abstraction`
**Status**: Complete

## Summary

This feature implements an abstraction layer for invoking AI coding agents (Claude Code, Copilot, Cursor) programmatically. The layer provides a unified interface for the workflow orchestrator to execute commands through different agent platforms while handling invocation, output capture, timeout management, and error handling.

## Technical Context

| Aspect | Choice |
|--------|--------|
| Language | TypeScript 5.4+ |
| Runtime | Node.js 20+ |
| Module System | ESM with `.js` extensions |
| Process Management | Node.js child_process (spawn) |
| Testing | Vitest with mocks |
| Patterns | Registry pattern, Strategy pattern |

### Key Dependencies

- `child_process` - Node.js built-in for subprocess management
- No additional dependencies required (minimizing footprint)

## Project Structure

```
src/
  agents/
    types.ts              # AgentInvoker interface, InvocationConfig, InvocationResult
    agent-registry.ts     # AgentRegistry class
    errors.ts             # AgentError, InvocationError types
    claude-code-invoker.ts  # Claude Code implementation
    index.ts              # Public exports
  types/
    index.ts              # Updated to export agent types

tests/
  agents/
    agent-registry.test.ts
    claude-code-invoker.test.ts
```

## Constitution Check

No constitution.md file exists in `.specify/memory/`. Proceeding with standard patterns from the existing codebase.

## Implementation Approach

### 1. Core Types (types.ts)

Define the foundational interfaces following the spec:

```typescript
// Feature capabilities
enum AgentFeature {
  Streaming = 'streaming',
  McpTools = 'mcp_tools'
}

// Invoker interface - strategy pattern for different agents
interface AgentInvoker {
  name: string;
  supports(feature: AgentFeature): boolean;
  invoke(config: InvocationConfig): Promise<InvocationResult>;
  isAvailable(): Promise<boolean>;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

// Invocation configuration
interface InvocationConfig {
  command: string;
  context: InvocationContext;
  timeout?: number;
  streaming?: boolean;
}

interface InvocationContext {
  workingDirectory: string;
  environment?: Record<string, string>;
  mode?: string;
  issueNumber?: number;
  branch?: string;
}

// Result types
interface InvocationResult {
  success: boolean;
  output: string;
  exitCode?: number;
  duration: number;
  toolCalls?: ToolCallRecord[];
  error?: InvocationError;
}

interface ToolCallRecord {
  toolName: string;
  success: boolean;
  duration: number;
  timestamp: Date;
  inputSummary?: string;
  outputSummary?: string;
  errorMessage?: string;
}

interface InvocationError {
  code: string;
  message: string;
  details?: unknown;
}
```

### 2. Agent Registry (agent-registry.ts)

Registry pattern for managing agent invokers:

```typescript
class AgentRegistry {
  private agents = new Map<string, AgentInvoker>();
  private defaultAgentName?: string;

  register(invoker: AgentInvoker): void;
  unregister(name: string): void;
  get(name: string): AgentInvoker | undefined;
  list(): AgentInvoker[];
  getDefault(): AgentInvoker;  // Throws if not configured or unavailable
  setDefault(name: string): void;
}
```

### 3. Error Types (errors.ts)

Hybrid error handling with dedicated error classes:

```typescript
// Infrastructure errors (thrown)
class AgentUnavailableError extends Error {}
class AgentInitializationError extends Error {}
class AgentNotFoundError extends Error {}
class DefaultAgentNotConfiguredError extends Error {}

// Invocation error codes (returned in result)
const InvocationErrorCodes = {
  TIMEOUT: 'TIMEOUT',
  COMMAND_FAILED: 'COMMAND_FAILED',
  AGENT_ERROR: 'AGENT_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
} as const;
```

### 4. Claude Code Invoker (claude-code-invoker.ts)

Built-in implementation for Claude Code CLI:

```typescript
class ClaudeCodeInvoker implements AgentInvoker {
  name = 'claude-code';

  private supportedFeatures = new Set([
    AgentFeature.Streaming,
    AgentFeature.McpTools
  ]);

  supports(feature: AgentFeature): boolean;

  async isAvailable(): Promise<boolean> {
    // Check if 'claude' CLI is accessible
  }

  async initialize(): Promise<void> {
    // Verify CLI is available, throw AgentInitializationError if not
  }

  async invoke(config: InvocationConfig): Promise<InvocationResult> {
    // Spawn claude process with:
    // - Working directory from context
    // - Environment variables merged with context.environment
    // - Mode passed via appropriate mechanism
    // - Timeout handling with process termination
    // - Output capture (stdout + stderr)
    // - Exit code handling
    // - Tool call parsing from output
  }

  async shutdown(): Promise<void> {
    // Cleanup any resources (no-op for CLI-based)
  }
}
```

### Key Implementation Details

#### Process Invocation

```typescript
// Use spawn for streaming output capture
const child = spawn('claude', args, {
  cwd: config.context.workingDirectory,
  env: { ...process.env, ...config.context.environment },
  stdio: ['pipe', 'pipe', 'pipe'],
});

// Track duration
const startTime = Date.now();

// Timeout handling
const timeoutId = config.timeout
  ? setTimeout(() => child.kill('SIGTERM'), config.timeout)
  : undefined;
```

#### Mode Handling

Mode flows through context and is passed to the Claude CLI:
- Via command argument: `--mode <mode>` or
- Via environment variable: `CLAUDE_MODE=<mode>`

#### Output Parsing

```typescript
// Capture output streams
let stdout = '';
let stderr = '';

child.stdout.on('data', (data) => { stdout += data; });
child.stderr.on('data', (data) => { stderr += data; });

// Parse tool calls from structured output if present
function parseToolCalls(output: string): ToolCallRecord[] {
  // Parse JSON-formatted tool call logs if available
  // Return empty array if not parseable (graceful degradation)
}
```

#### Error Handling Strategy

| Scenario | Approach |
|----------|----------|
| CLI not found | Throw `AgentUnavailableError` (infrastructure) |
| CLI not executable | Throw `AgentInitializationError` (infrastructure) |
| Process timeout | Return `{ success: false, error: { code: 'TIMEOUT' } }` |
| Non-zero exit | Return `{ success: false, error: { code: 'COMMAND_FAILED' } }` |
| Parse error | Return `{ success: true, toolCalls: [] }` (graceful degradation) |

## Testing Strategy

### Unit Tests

1. **agent-registry.test.ts**
   - Registration/unregistration
   - Get by name
   - List all agents
   - Default agent configuration
   - Error cases (not found, duplicate, default not configured)

2. **claude-code-invoker.test.ts**
   - Mock `child_process.spawn`
   - Test successful invocation with output capture
   - Test timeout handling
   - Test non-zero exit code handling
   - Test mode passing
   - Test tool call parsing

### Mock Strategy

```typescript
// Mock spawn for testing without actual CLI
vi.mock('child_process', () => ({
  spawn: vi.fn(() => createMockProcess()),
}));

function createMockProcess(options?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delay?: number;
}): MockChildProcess {
  // Return mock with event emitters and configurable behavior
}
```

## File Dependencies

```
types.ts → errors.ts (imports error types)
agent-registry.ts → types.ts, errors.ts
claude-code-invoker.ts → types.ts, errors.ts
index.ts → all above
```

## Integration Points

- **Workflow Orchestrator**: Primary consumer of the agent abstraction
- **Configuration System**: Provides default agent name
- **Logging**: Tool call records enable debugging workflows

---

*Generated by speckit*
