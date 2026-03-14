# Data Model: Interactive Conversation Proxy

## Core Entities

### ConversationHandle

Tracks an active conversation process within the orchestrator (in-memory only).

```typescript
interface ConversationHandle {
  /** Unique conversation identifier (provided by caller) */
  conversationId: string;
  /** Resolved workspace path (filesystem) */
  workingDirectory: string;
  /** Workspace identifier from start request (e.g., "primary") */
  workspaceId: string;
  /** Whether permissions are skipped (--dangerously-skip-permissions) */
  skipPermissions: boolean;
  /** Claude CLI session ID (captured from init event) */
  sessionId?: string;
  /** Reference to the spawned process */
  process: ChildProcessHandle;
  /** Process start timestamp (ISO 8601) */
  startedAt: string;
  /** Model used for the conversation */
  model?: string;
  /** Initial command sent on start (e.g., '/onboard-evaluate') */
  initialCommand?: string;
  /** Current state */
  state: 'starting' | 'active' | 'ending' | 'ended';
}
```

### ConversationInfo

Public-facing metadata for list/status queries (returned by API).

```typescript
interface ConversationInfo {
  conversationId: string;
  workspaceId: string;
  model?: string;
  skipPermissions: boolean;
  startedAt: string;
  state: 'starting' | 'active' | 'ending' | 'ended';
}
```

### ConversationStartOptions

Input for starting a new conversation.

```typescript
interface ConversationStartOptions {
  /** Unique conversation ID (caller-provided, e.g., UUID) */
  conversationId: string;
  /** Workspace identifier — resolved by orchestrator to filesystem path */
  workingDirectory: string;
  /** Optional initial command to send as first message */
  initialCommand?: string;
  /** Claude model to use (optional, uses CLI default if omitted) */
  model?: string;
  /** Skip permission prompts (default true) */
  skipPermissions?: boolean;
}
```

## Relay Message Schemas

### Cloud → Cluster: Conversation Input

Sent when the cloud UI delivers a user message to an active conversation.

```typescript
interface ConversationInputMessage {
  type: 'conversation';
  conversationId: string;
  data: {
    action: 'message';
    content: string;
  };
}
```

### Cluster → Cloud: Conversation Output

Sent when the orchestrator streams Claude CLI output to the cloud.

```typescript
interface ConversationOutputMessage {
  type: 'conversation';
  conversationId: string;
  data: {
    event: 'output' | 'tool_use' | 'tool_result' | 'complete' | 'error';
    payload: unknown;
    timestamp: string;
  };
}
```

### Event Types Mapping

| CLI Output Type | Conversation Event | Payload |
|----------------|-------------------|---------|
| `init` | `output` | `{ sessionId, model }` |
| `text` | `output` | `{ text: string }` |
| `tool_use` | `tool_use` | `{ toolName, callId, input }` |
| `tool_result` | `tool_result` | `{ toolName, callId, output, filePath? }` |
| `complete` | `complete` | `{ tokensIn, tokensOut }` |
| `error` | `error` | `{ message, code? }` |
| (process exit) | `error` | `{ message: 'Process exited', exitCode }` |

## Zod Schemas

### Conversation Start Request

```typescript
const ConversationStartSchema = z.object({
  conversationId: z.string().min(1).max(128),
  workingDirectory: z.string().min(1).max(64),
  initialCommand: z.string().max(4096).optional(),
  model: z.string().max(64).optional(),
  skipPermissions: z.boolean().default(true),
});
```

### Conversation Message Request

```typescript
const ConversationMessageSchema = z.object({
  message: z.string().min(1).max(65536),
});
```

### Conversation Relay Data (refined)

```typescript
const ConversationRelayInputSchema = z.object({
  action: z.literal('message'),
  content: z.string().min(1).max(65536),
});

const ConversationRelayOutputSchema = z.object({
  event: z.enum(['output', 'tool_use', 'tool_result', 'complete', 'error']),
  payload: z.unknown(),
  timestamp: z.string().datetime(),
});
```

## Configuration Schema

### ConversationConfig

```typescript
const ConversationConfigSchema = z.object({
  /** Maximum concurrent conversations (0 = disabled) */
  maxConcurrent: z.number().int().min(0).max(20).default(3),
  /** Grace period for SIGKILL after SIGTERM (ms) */
  shutdownGracePeriodMs: z.number().int().min(1000).max(60000).default(5000),
  /** Workspace identifier → filesystem path mapping */
  workspaces: z.record(z.string(), z.string()).default({}),
  /** Default model (optional — uses Claude CLI default if omitted) */
  defaultModel: z.string().optional(),
});
```

Added to `OrchestratorConfigSchema`:
```typescript
conversations: ConversationConfigSchema.default({})
```

## Relationships

```
ConversationManager (1) ──── manages ────> ConversationHandle (0..N)
       │                                         │
       │ uses                                    │ wraps
       ▼                                         ▼
ConversationSpawner                       ChildProcessHandle
       │                                   (from worker/types.ts)
       │ creates via
       ▼
ProcessFactory
(from worker/types.ts)

RelayBridge ──── routes ────> ConversationManager
   │                              │
   │ sends conversation           │ emits conversation
   │ messages via relay           │ output events
   ▼                              ▼
ClusterRelayClient          ConversationOutputMessage
```

## State Transitions

```
                    start()
                      │
                      ▼
                  ┌──────────┐
                  │ starting  │
                  └────┬─────┘
                       │  CLI process spawned, init event received
                       ▼
                  ┌──────────┐
           ┌──────│  active   │──────┐
           │      └──────────┘      │
           │                        │
      end() called           process exits unexpectedly
           │                        │
           ▼                        ▼
      ┌──────────┐            ┌──────────┐
      │  ending   │            │  ended   │
      └────┬─────┘            └──────────┘
           │  process exits
           ▼
      ┌──────────┐
      │  ended   │
      └──────────┘
```

## Validation Rules

| Field | Rule |
|-------|------|
| `conversationId` | Non-empty string, max 128 chars, unique among active conversations |
| `workingDirectory` | Must match a key in `conversations.workspaces` config |
| `message` | Non-empty string, max 64KB |
| `model` | Optional; if provided, max 64 chars |
| `skipPermissions` | Boolean, defaults to `true` |
| Active conversation count | Must be < `maxConcurrent` to start a new one |
