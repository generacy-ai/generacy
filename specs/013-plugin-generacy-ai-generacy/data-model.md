# Data Model: Plugin: @generacy-ai/generacy-plugin-claude-code

## Core Entities

### Session

Represents an active Claude Code agent session within a container.

```typescript
interface Session {
  /** Unique session identifier */
  id: string;

  /** Current session state */
  state: SessionState;

  /** Container configuration used for this session */
  containerConfig: ContainerConfig;

  /** Docker container ID when running */
  containerId?: string;

  /** When the session was created */
  createdAt: Date;

  /** When the session was last active */
  lastActiveAt: Date;

  /** Default options for invocations in this session */
  defaultOptions: InvokeOptions;
}
```

### SessionState

Discriminated union representing session lifecycle states.

```typescript
type SessionState =
  | { status: 'created' }
  | { status: 'running'; containerId: string }
  | { status: 'executing'; invocationId: string; containerId: string }
  | { status: 'awaiting_input'; question: QuestionPayload; containerId: string }
  | { status: 'terminated'; reason: TerminationReason };

type SessionStatus = SessionState['status'];

type TerminationReason =
  | 'user_requested'
  | 'timeout'
  | 'container_crashed'
  | 'error';
```

### ContainerConfig

Configuration for the Docker container running the agent.

```typescript
interface ContainerConfig {
  /** Docker image to use */
  image: string;

  /** Working directory inside container */
  workdir: string;

  /** Environment variables */
  env: Record<string, string>;

  /** Volume mounts */
  mounts: Mount[];

  /** Docker network name */
  network: string;

  /** Optional resource limits */
  resources?: ResourceLimits;
}

interface Mount {
  /** Host path or volume name */
  source: string;

  /** Container path */
  target: string;

  /** Read-only mount */
  readonly?: boolean;
}

interface ResourceLimits {
  /** Memory limit in bytes */
  memory?: number;

  /** CPU quota (e.g., 1.5 for 1.5 CPUs) */
  cpus?: number;
}
```

### InvokeParams

Parameters for invoking Claude Code.

```typescript
interface InvokeParams {
  /** The prompt to send to Claude Code */
  prompt: string;

  /** Optional session ID for session-based invocation */
  sessionId?: string;

  /** Override session defaults */
  options?: Partial<InvokeOptions>;
}
```

### InvokeOptions

Options that control invocation behavior.

```typescript
interface InvokeOptions {
  /** Agency mode to set before invocation */
  mode?: string;

  /** Maximum execution time in milliseconds */
  timeout?: number;

  /** Tool whitelist (empty = all allowed) */
  tools?: string[];

  /** Serialized context for workflow continuity */
  context?: string;

  /** Associated GitHub issue number */
  issueNumber?: number;
}
```

### InvocationResult

Result of a completed invocation.

```typescript
interface InvocationResult {
  /** Whether the invocation completed successfully */
  success: boolean;

  /** Session ID used for this invocation */
  sessionId: string;

  /** Unique invocation identifier */
  invocationId: string;

  /** Exit code from Claude Code */
  exitCode: number;

  /** Summary of what was accomplished */
  summary?: string;

  /** Files that were modified */
  filesModified?: string[];

  /** Duration in milliseconds */
  duration: number;

  /** Error if invocation failed */
  error?: InvocationError;
}
```

### OutputChunk

Structured output from Claude Code streaming.

```typescript
interface OutputChunk {
  /** Type of output */
  type: OutputChunkType;

  /** When this chunk was received */
  timestamp: Date;

  /** Type-specific payload */
  data: unknown;

  /** Optional metadata */
  metadata?: OutputMetadata;
}

type OutputChunkType =
  | 'stdout'
  | 'stderr'
  | 'tool_call'
  | 'tool_result'
  | 'question'
  | 'complete'
  | 'error';

interface OutputMetadata {
  /** Tool name for tool_call/tool_result */
  toolName?: string;

  /** File path for file operations */
  filePath?: string;

  /** Whether tool execution succeeded */
  isSuccess?: boolean;

  /** Urgency level for questions */
  urgency?: UrgencyLevel;
}

type UrgencyLevel = 'blocking_now' | 'blocking_soon' | 'when_available';
```

### QuestionPayload

Payload for human decision questions.

```typescript
interface QuestionPayload {
  /** Question text */
  question: string;

  /** Urgency level */
  urgency: UrgencyLevel;

  /** Optional choices */
  choices?: string[];

  /** Additional context */
  context?: string;

  /** When the question was asked */
  askedAt: Date;
}
```

### InvocationError

Error information for failed invocations.

```typescript
interface InvocationError {
  /** Error classification code */
  code: ErrorCode;

  /** Whether this error is transient (retryable) */
  isTransient: boolean;

  /** Human-readable error message */
  message: string;

  /** Additional error context */
  context?: unknown;
}

type ErrorCode =
  | 'CONTAINER_CRASHED'
  | 'API_TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'UNKNOWN';
```

## Relationships

```
┌──────────────────┐
│  ClaudeCodePlugin │
└────────┬─────────┘
         │ manages
         ▼
┌──────────────────┐       ┌──────────────────┐
│  SessionManager  │───────│     Session      │
└──────────────────┘ 1:N   └────────┬─────────┘
                                    │ has
                                    ▼
                           ┌──────────────────┐
                           │  SessionState    │
                           └────────┬─────────┘
                                    │ contains (when awaiting_input)
                                    ▼
                           ┌──────────────────┐
                           │ QuestionPayload  │
                           └──────────────────┘

┌──────────────────┐
│     Session      │
└────────┬─────────┘
         │ produces
         ▼
┌──────────────────┐
│  OutputChunk[]   │ (stream)
└──────────────────┘

┌──────────────────┐
│  InvokeParams    │
└────────┬─────────┘
         │ results in
         ▼
┌──────────────────┐
│ InvocationResult │
└────────┬─────────┘
         │ may contain
         ▼
┌──────────────────┐
│ InvocationError  │
└──────────────────┘
```

## Validation Rules

### ContainerConfig

| Field | Rule |
|-------|------|
| image | Required, non-empty string |
| workdir | Required, absolute path starting with `/` |
| env | Optional, all values must be strings |
| mounts | Each mount must have source and target |
| network | Required, valid Docker network name |

### InvokeParams

| Field | Rule |
|-------|------|
| prompt | Required, non-empty string |
| sessionId | Optional, if provided must exist in SessionManager |
| options | Optional, validated against InvokeOptions schema |

### InvokeOptions

| Field | Rule |
|-------|------|
| mode | Optional, must be valid Agency mode name |
| timeout | Optional, positive integer, max 1 hour (3600000ms) |
| tools | Optional, array of valid tool names |
| context | Optional, string (serialized JSON) |
| issueNumber | Optional, positive integer |

### OutputChunk

| Field | Rule |
|-------|------|
| type | Required, one of defined OutputChunkType values |
| timestamp | Required, valid Date |
| data | Required (can be null for some types) |
| metadata | Optional, validated based on type |

## Type Guards

```typescript
// Type guard for question chunks
function isQuestionChunk(chunk: OutputChunk): chunk is OutputChunk & {
  type: 'question';
  data: QuestionPayload;
} {
  return chunk.type === 'question' && chunk.data !== null;
}

// Type guard for error chunks
function isErrorChunk(chunk: OutputChunk): chunk is OutputChunk & {
  type: 'error';
  data: { message: string; code?: string };
} {
  return chunk.type === 'error';
}

// Type guard for running session state
function isSessionRunning(state: SessionState): state is SessionState & {
  status: 'running' | 'executing' | 'awaiting_input';
  containerId: string;
} {
  return ['running', 'executing', 'awaiting_input'].includes(state.status);
}
```

## Zod Schemas

```typescript
import { z } from 'zod';

export const MountSchema = z.object({
  source: z.string().min(1),
  target: z.string().startsWith('/'),
  readonly: z.boolean().optional(),
});

export const ContainerConfigSchema = z.object({
  image: z.string().min(1),
  workdir: z.string().startsWith('/'),
  env: z.record(z.string()).default({}),
  mounts: z.array(MountSchema).default([]),
  network: z.string().min(1),
  resources: z.object({
    memory: z.number().positive().optional(),
    cpus: z.number().positive().optional(),
  }).optional(),
});

export const InvokeOptionsSchema = z.object({
  mode: z.string().optional(),
  timeout: z.number().int().positive().max(3600000).optional(),
  tools: z.array(z.string()).optional(),
  context: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
});

export const InvokeParamsSchema = z.object({
  prompt: z.string().min(1),
  sessionId: z.string().optional(),
  options: InvokeOptionsSchema.partial().optional(),
});
```
