# Research: Plugin: @generacy-ai/generacy-plugin-claude-code

## Technology Decisions

### 1. Docker Client Library

**Decision**: dockerode

| Library | Stars | Maintenance | API Coverage | Stream Support |
|---------|-------|-------------|--------------|----------------|
| dockerode | 4.4k | Active | Full | Yes |
| node-docker-api | 400 | Limited | Partial | Limited |
| docker-cli-js | 100 | Inactive | CLI wrapper | No |

**Rationale**: dockerode provides the most complete Docker API coverage with excellent stream handling, which is critical for our output streaming requirement.

**Installation**:
```bash
npm install dockerode @types/dockerode
```

### 2. Claude Code CLI Interface

**Headless Mode Command**:
```bash
claude --headless --prompt "prompt text" --output json
```

**Output Format**: JSON Lines (newline-delimited JSON)
- Each line is a complete JSON object
- Types: `stdout`, `stderr`, `tool_call`, `tool_result`, `complete`, `error`

**Environment Variables**:
- `ANTHROPIC_API_KEY` - Required for API access
- `CLAUDE_CODE_USE_SANDBOX` - Container sandbox setting

### 3. Async Streaming Pattern

**Pattern**: Async Generator with ReadableStream adapter

```typescript
async function* parseOutputStream(
  stream: NodeJS.ReadableStream
): AsyncGenerator<OutputChunk> {
  const lineReader = readline.createInterface({ input: stream });

  for await (const line of lineReader) {
    try {
      const chunk = JSON.parse(line) as RawOutputChunk;
      yield transformToOutputChunk(chunk);
    } catch (e) {
      yield { type: 'stdout', timestamp: new Date(), data: line };
    }
  }
}
```

### 4. Session State Management

**Pattern**: TypeScript State Machine with Discriminated Unions

```typescript
type SessionState =
  | { status: 'created' }
  | { status: 'running'; containerId: string }
  | { status: 'executing'; invocationId: string }
  | { status: 'awaiting_input'; question: QuestionPayload }
  | { status: 'terminated'; reason: string };
```

### 5. Container Configuration

**Base Image Strategy**: Use pre-built dev container images with Claude Code installed.

**Required Environment**:
- Node.js 20+
- Claude Code CLI
- Agency CLI (for mode setting)
- Git

**Volume Mounts**:
- Workspace directory (read-write)
- SSH keys (read-only, if needed)
- npm cache (optional, performance)

## Implementation Patterns

### Registry Pattern (from existing codebase)

Reference: `/workspaces/generacy/src/agents/agent-registry.ts`

```typescript
class SessionManager {
  private sessions = new Map<string, Session>();

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  register(session: Session): void {
    this.sessions.set(session.id, session);
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
```

### Error Class Pattern (from existing codebase)

Reference: `/workspaces/generacy/src/agents/errors.ts`

```typescript
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

export class ContainerStartError extends Error {
  constructor(reason: string, public readonly isTransient: boolean = true) {
    super(`Failed to start container: ${reason}`);
    this.name = 'ContainerStartError';
  }
}
```

### Event Emitter Pattern (from existing codebase)

Reference: `/workspaces/generacy/src/channels/channel-registry.ts`

```typescript
interface SessionEvents {
  'state:changed': (from: SessionStatus, to: SessionStatus) => void;
  'output:chunk': (chunk: OutputChunk) => void;
  'question': (question: QuestionPayload) => void;
}
```

## API Design

### Public API Surface

```typescript
// Main entry point
export class ClaudeCodePlugin {
  // Invocation
  invoke(params: InvokeParams): Promise<InvocationResult>;
  invokeWithPrompt(prompt: string, options?: InvokeOptions): Promise<InvocationResult>;

  // Session management
  startSession(container: ContainerConfig): Promise<Session>;
  continueSession(sessionId: string, prompt: string): Promise<InvocationResult>;
  endSession(sessionId: string): Promise<void>;

  // Output handling
  streamOutput(sessionId: string): AsyncIterable<OutputChunk>;

  // Mode control
  setMode(sessionId: string, mode: string): Promise<void>;
}
```

### Internal Components

```typescript
// Not exported publicly
class ContainerManager { /* ... */ }
class SessionManager { /* ... */ }
class OutputParser { /* ... */ }
class Invoker { /* ... */ }
```

## References

### Claude Code Documentation

- Headless mode: `claude --help` for CLI options
- JSON output format: Follows Claude Code's native JSON streaming

### Docker API

- Container creation: https://docs.docker.com/engine/api/v1.45/#tag/Container/operation/ContainerCreate
- Attach streams: https://docs.docker.com/engine/api/v1.45/#tag/Container/operation/ContainerAttach

### Related Generacy Code

| File | Relevance |
|------|-----------|
| `src/agents/types.ts` | Agent interface patterns |
| `src/agents/agent-registry.ts` | Registry pattern |
| `src/worker/types.ts` | Container config types |
| `src/channels/channel-registry.ts` | Event emitter pattern |
| `packages/orchestrator/` | Package structure reference |

## Alternative Approaches Considered

### 1. Direct Process Spawn vs Docker

**Considered**: Spawn Claude Code directly without containers.

**Rejected**:
- No isolation between invocations
- Can't control environment consistently
- Spec explicitly requires container isolation

### 2. WebSocket vs Stdio Streaming

**Considered**: WebSocket connection for output streaming.

**Rejected**:
- Adds complexity for inter-container communication
- Docker attach streams work well for stdio
- Claude Code's native output is stdio-based

### 3. Persistent Sessions vs Ephemeral

**Considered**: Store session state in Redis for cross-container persistence.

**Rejected**:
- Spec clarifications explicitly chose ephemeral sessions
- Workflow engine handles continuity at higher level
- Simpler implementation, clearer boundaries
