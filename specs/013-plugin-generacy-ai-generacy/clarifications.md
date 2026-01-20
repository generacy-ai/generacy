# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-20 03:30

### Q1: InvokeParams Definition
**Context**: The ClaudeCodePlugin interface references InvokeParams but this type is not defined. Implementation cannot proceed without knowing what parameters are required for agent invocation.
**Question**: What should the InvokeParams interface contain? Should it combine prompt, options, and container config, or be a subset?
**Options**:
- A: Combine all: { prompt: string, options?: InvokeOptions, container: ContainerConfig }
- B: Minimal: { prompt: string } with options/container set via session
- C: Reference-based: { sessionId: string, prompt: string } requiring pre-created session

**Answer**: **B** — Minimal: `{ prompt: string }` with options/container set via session

**Rationale:** The architecture shows sessions as first-class concepts (`startSession`, `continueSession`, `endSession`). Sessions manage container lifecycle and configuration. The compatibility docs emphasize "thin, stable contracts" with extensible payloads. This keeps invocation simple while allowing either ad-hoc invocation (auto-creates ephemeral session) or session-based invocation.

```typescript
interface InvokeParams {
  prompt: string;
  sessionId?: string;  // If provided, uses existing session
  options?: Partial<InvokeOptions>;  // Override session defaults
}
```

### Q2: OutputChunk Structure
**Context**: The streamOutput method returns AsyncIterable<OutputChunk> but the structure is undefined. This is critical for real-time output handling and telemetry.
**Question**: What should OutputChunk contain for streaming output?
**Options**:
- A: Simple: { type: 'stdout'|'stderr'|'tool'|'complete', content: string, timestamp: Date }
- B: Structured: { type: string, data: unknown, metadata: { toolName?, filePath?, etc. } }
- C: Match Claude Code's native JSON output format exactly

**Answer**: **B** — Structured: `{ type: string, data: unknown, metadata: { toolName?, filePath?, etc. } }`

**Rationale:** The compatibility docs emphasize "Thin, Stable Contracts" with extensible payloads like `payload: Record<string, unknown>`. The "Terse Output Pattern" requires differentiating success (minimal) from failure (detailed). This aligns with the "passthrough" pattern in the contracts package.

```typescript
interface OutputChunk {
  type: 'stdout' | 'stderr' | 'tool_call' | 'tool_result' | 'question' | 'complete' | 'error';
  timestamp: Date;
  data: unknown;  // Type-specific payload
  metadata?: {
    toolName?: string;
    filePath?: string;
    isSuccess?: boolean;
    urgency?: 'blocking_now' | 'blocking_soon' | 'when_available';
  };
}
```

### Q3: Human Decision Handling
**Context**: The spec mentions 'Handle human decisions' under Agency integration but doesn't specify the mechanism. This affects how the plugin communicates back when user input is needed.
**Question**: How should the plugin handle scenarios where Claude Code asks a question requiring human decision?
**Options**:
- A: Pause session and emit a special event, caller must call continueSession with answer
- B: Callback/webhook mechanism configured in InvokeOptions
- C: Queue decisions for batch review, continue with defaults

**Answer**: **A** — Pause session and emit a special event, caller must call `continueSession` with answer

**Rationale:** The architecture is explicit about this pattern in `humancy-decision-framework.md`. The `humancy.request_decision` pattern with urgency levels (`blocking_now`, `blocking_soon`, `when_available`) requires explicit human decisions. The session API already has `continueSession(sessionId, prompt)` which is the natural place to provide the answer.

- `OutputChunk` with `type: 'question'` includes urgency and question details
- Session enters "awaiting_input" state
- `continueSession(sessionId, answer)` resumes with human's response
- Integrates with Humancy's decision queue naturally

### Q4: Session Persistence
**Context**: Sessions support continue/end but it's unclear if sessions survive container restarts or are purely in-memory. This affects reliability and cost.
**Question**: Should sessions persist across container restarts, or are they ephemeral within a container lifecycle?
**Options**:
- A: Ephemeral: Session dies with container, caller must handle reconnection
- B: Persistent: Store session state externally, recreate container on continue
- C: Hybrid: Short-lived ephemeral, with explicit checkpoint/restore for long tasks

**Answer**: **A** — Ephemeral: Session dies with container, caller must handle reconnection

**Rationale:** The architecture emphasizes "isolated containers" for agents. Generacy's workflow engine sits *above* sessions and handles orchestration. The docs show workflows being "decoupled from inner agent workflows." Containers are meant to be disposable.

**Enhancement:** Include a `context` field in `InvokeOptions` for serialized context, allowing Generacy's workflow engine to handle cross-container continuity at the workflow level (not session level).

### Q5: Error Recovery Strategy
**Context**: The acceptance criteria mentions 'Error handling robust' but doesn't specify recovery behavior for common failures like container crashes or API timeouts.
**Question**: What error recovery behavior is expected for transient failures?
**Options**:
- A: Fail fast: Surface error immediately, caller handles retry
- B: Auto-retry: Built-in retry with exponential backoff for transient errors
- C: Checkpoint: Save progress periodically, allow resume from last checkpoint

**Answer**: **A** — Fail fast: Surface error immediately, caller handles retry

**Rationale:** Generacy is the orchestration layer — retry logic belongs in workflows, not plugins. The "Terse Output Pattern" emphasizes clear error reporting: "detailed response on failure."

**Enhancement:** Include rich error classification to help the workflow engine make retry decisions:

```typescript
interface InvocationError {
  code: 'CONTAINER_CRASHED' | 'API_TIMEOUT' | 'RATE_LIMITED' | 'AUTH_FAILED' | 'UNKNOWN';
  isTransient: boolean;  // Hint to workflow engine
  message: string;
  context?: unknown;
}
```

