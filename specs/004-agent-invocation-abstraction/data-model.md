# Data Model: Agent Invocation Abstraction

## Core Entities

### AgentFeature (Enum)

Capability flags for agent feature detection.

```typescript
enum AgentFeature {
  Streaming = 'streaming',
  McpTools = 'mcp_tools'
}
```

| Value | Description |
|-------|-------------|
| `streaming` | Agent supports streaming output |
| `mcp_tools` | Agent supports MCP tool protocol |

### AgentInvoker (Interface)

The primary abstraction for invoking AI coding agents.

```typescript
interface AgentInvoker {
  /** Unique identifier for this agent type */
  readonly name: string;

  /** Check if agent supports a specific feature */
  supports(feature: AgentFeature): boolean;

  /** Execute a command through the agent */
  invoke(config: InvocationConfig): Promise<InvocationResult>;

  /** Check if agent is available without side effects */
  isAvailable(): Promise<boolean>;

  /** Prepare agent for invocation (may throw on failure) */
  initialize(): Promise<void>;

  /** Clean up agent resources */
  shutdown(): Promise<void>;
}
```

### InvocationConfig

Configuration for a single agent invocation.

```typescript
interface InvocationConfig {
  /** The command to execute (e.g., "/speckit:specify") */
  command: string;

  /** Execution context */
  context: InvocationContext;

  /** Optional timeout in milliseconds */
  timeout?: number;

  /** Whether to enable streaming (if supported) */
  streaming?: boolean;
}

interface InvocationContext {
  /** Working directory for the agent process */
  workingDirectory: string;

  /** Additional environment variables */
  environment?: Record<string, string>;

  /** Operating mode for the agent */
  mode?: string;

  /** Associated issue number (for context) */
  issueNumber?: number;

  /** Current git branch (for context) */
  branch?: string;
}
```

### InvocationResult

Result of an agent invocation.

```typescript
interface InvocationResult {
  /** Whether the invocation completed successfully */
  success: boolean;

  /** Combined stdout/stderr output */
  output: string;

  /** Process exit code (if applicable) */
  exitCode?: number;

  /** Total invocation duration in milliseconds */
  duration: number;

  /** Tool calls made during execution */
  toolCalls?: ToolCallRecord[];

  /** Error details when success=false */
  error?: InvocationError;
}
```

### ToolCallRecord

Record of a tool call made during invocation.

```typescript
interface ToolCallRecord {
  /** Name of the tool that was called */
  toolName: string;

  /** Whether the tool call succeeded */
  success: boolean;

  /** Duration of the tool call in milliseconds */
  duration: number;

  /** When the tool was called */
  timestamp: Date;

  /** Truncated summary of input (more detail on failure) */
  inputSummary?: string;

  /** Truncated summary of output */
  outputSummary?: string;

  /** Error message if tool call failed */
  errorMessage?: string;
}
```

### InvocationError

Error details for failed invocations.

```typescript
interface InvocationError {
  /** Error code for programmatic handling */
  code: InvocationErrorCode;

  /** Human-readable error message */
  message: string;

  /** Additional error context */
  details?: unknown;
}

type InvocationErrorCode =
  | 'TIMEOUT'
  | 'COMMAND_FAILED'
  | 'AGENT_ERROR'
  | 'PARSE_ERROR';
```

## Registry Types

### AgentRegistry

Registry for managing agent invokers.

```typescript
class AgentRegistry {
  private agents: Map<string, AgentInvoker>;
  private defaultAgentName?: string;
}
```

## Error Types

### Infrastructure Errors (Thrown)

```typescript
/** Agent CLI/binary is not available */
class AgentUnavailableError extends Error {
  constructor(agentName: string);
}

/** Agent failed to initialize */
class AgentInitializationError extends Error {
  constructor(agentName: string, cause?: Error);
}

/** Requested agent not found in registry */
class AgentNotFoundError extends Error {
  constructor(agentName: string);
}

/** Default agent not configured */
class DefaultAgentNotConfiguredError extends Error {}

/** Agent already registered */
class AgentExistsError extends Error {
  constructor(agentName: string);
}
```

## Type Relationships

```
AgentRegistry
    │
    └── contains Map<string, AgentInvoker>
                         │
                         └── invokes → InvocationConfig
                         │                    │
                         │                    └── contains InvocationContext
                         │
                         └── returns → InvocationResult
                                           │
                                           ├── contains ToolCallRecord[]
                                           │
                                           └── contains InvocationError?
```

## Validation Rules

### InvocationConfig

| Field | Rule |
|-------|------|
| `command` | Non-empty string |
| `context.workingDirectory` | Must be valid path |
| `timeout` | If present, must be > 0 |

### ToolCallRecord

| Field | Rule |
|-------|------|
| `toolName` | Non-empty string |
| `duration` | >= 0 |
| `timestamp` | Valid Date |
| `inputSummary` | Max 500 chars (truncated) |
| `outputSummary` | Max 500 chars (truncated) |

### AgentRegistry

| Operation | Rule |
|-----------|------|
| `register` | Agent name must be unique |
| `setDefault` | Agent must be registered |
| `getDefault` | Must have default configured |

---

*Generated by speckit*
