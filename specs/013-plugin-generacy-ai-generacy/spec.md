# Feature Specification: Plugin: @generacy-ai/generacy-plugin-claude-code

**Branch**: `013-plugin-generacy-ai-generacy` | **Date**: 2026-01-20 | **Status**: Draft

## Summary

Implement the Claude Code agent platform plugin for Generacy. This plugin provides a thin interface for invoking Claude Code agents in isolated containers, with session management, output streaming, and integration with the Humancy decision framework.

## Parent Epic

#11 - Generacy Official Plugins

## Dependencies

- #2 - Generacy Core Package
- generacy-ai/agency - Agency running in agent container

## Features

### Agent Invocation

```typescript
interface ClaudeCodePlugin {
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

### InvokeParams (Minimal Contract)

Sessions manage state; invocation stays simple:
```typescript
interface InvokeParams {
  prompt: string;
  sessionId?: string;              // If provided, uses existing session
  options?: Partial<InvokeOptions>; // Override session defaults
}
```

### Container Management

Agents run in isolated, ephemeral containers:
```typescript
interface ContainerConfig {
  image: string;                   // Dev container image
  workdir: string;                 // Working directory
  env: Record<string, string>;     // Environment variables
  mounts: Mount[];                 // Volume mounts
  network: string;                 // Docker network
}
```

**Session Persistence**: Sessions are ephemeral - they die with the container. Generacy's workflow engine handles cross-container continuity at the workflow level via the `context` field in InvokeOptions.

### Invocation Options

```typescript
interface InvokeOptions {
  mode?: string;                   // Agency mode
  timeout?: number;                // Max execution time
  tools?: string[];                // Tool whitelist
  context?: string;                // Serialized context for workflow continuity
  issueNumber?: number;            // Associated issue
}
```

### OutputChunk (Structured with Extensible Payloads)

Follows "thin contracts + extensible payloads" pattern:
```typescript
interface OutputChunk {
  type: 'stdout' | 'stderr' | 'tool_call' | 'tool_result' | 'question' | 'complete' | 'error';
  timestamp: Date;
  data: unknown;                   // Type-specific payload
  metadata?: {
    toolName?: string;
    filePath?: string;
    isSuccess?: boolean;
    urgency?: 'blocking_now' | 'blocking_soon' | 'when_available';
  };
}
```

### Human Decision Handling

When Claude Code asks a question requiring human decision:
- `OutputChunk` with `type: 'question'` is emitted, including urgency and question details
- Session enters "awaiting_input" state
- Caller must call `continueSession(sessionId, answer)` to resume with human's response
- Integrates with Humancy's decision queue naturally

### Error Handling (Fail Fast)

Plugin reports errors immediately; workflow engine decides retry policy:
```typescript
interface InvocationError {
  code: 'CONTAINER_CRASHED' | 'API_TIMEOUT' | 'RATE_LIMITED' | 'AUTH_FAILED' | 'UNKNOWN';
  isTransient: boolean;            // Hint to workflow engine
  message: string;
  context?: unknown;
}
```

### Headless Mode

Run without interactive terminal:
```bash
claude --headless --prompt "implement feature X" --output json
```

### Integration with Agency

- Set mode before invocation
- Pass feature context via InvokeOptions.context
- Capture telemetry via OutputChunk stream
- Handle human decisions via question/continueSession pattern

## Acceptance Criteria

- [ ] Can invoke Claude Code in container
- [ ] Mode setting works
- [ ] Output streaming works with structured OutputChunk
- [ ] Session management works (start/continue/end)
- [ ] Headless mode works
- [ ] Error handling is fail-fast with rich InvocationError
- [ ] Human decision handling via question/continueSession pattern

## User Stories

### US1: Orchestrator Invokes Agent

**As a** Generacy orchestrator,
**I want** to invoke a Claude Code agent with a prompt in an isolated container,
**So that** I can execute automated development tasks safely.

**Acceptance Criteria**:
- [ ] Can start a session with container config
- [ ] Can invoke with a prompt
- [ ] Can stream output chunks in real-time

### US2: Handle Human Decisions

**As a** Generacy orchestrator,
**I want** to receive questions from the agent and provide answers,
**So that** the agent can make decisions that require human input.

**Acceptance Criteria**:
- [ ] OutputChunk with type 'question' includes urgency level
- [ ] Session pauses until continueSession is called
- [ ] Answer is passed to the agent correctly

### US3: Handle Agent Errors

**As a** Generacy orchestrator,
**I want** detailed error information when an invocation fails,
**So that** I can decide whether to retry or escalate.

**Acceptance Criteria**:
- [ ] InvocationError includes error code and isTransient hint
- [ ] Container crashes are detected and reported
- [ ] Timeouts are handled gracefully

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Invoke Claude Code in Docker container | P1 | Uses headless mode |
| FR-002 | Stream output as structured OutputChunks | P1 | Real-time streaming |
| FR-003 | Session lifecycle management | P1 | start/continue/end |
| FR-004 | Mode setting via Agency integration | P1 | Before invocation |
| FR-005 | Handle human decisions via question pattern | P1 | Integrates with Humancy |
| FR-006 | Fail-fast error reporting | P1 | Rich InvocationError type |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Invocation success rate | >95% | Successful completions / total invocations |
| SC-002 | Human decision response time | <5s latency | Time from question emit to continueSession |
| SC-003 | Error classification accuracy | 100% | All errors have correct code and isTransient |

## Assumptions

- Claude Code supports `--headless` mode with JSON output
- Docker is available on the host system
- Agency is installed in the container image
- Generacy Core Package provides base plugin interface

## Out of Scope

- Session persistence across container restarts (handled at workflow level)
- Automatic retry logic (handled by workflow engine)
- Multi-agent orchestration (handled by Generacy orchestrator)

---

*Generated by speckit*
