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

**Answer**: *Pending*

### Q2: OutputChunk Structure
**Context**: The streamOutput method returns AsyncIterable<OutputChunk> but the structure is undefined. This is critical for real-time output handling and telemetry.
**Question**: What should OutputChunk contain for streaming output?
**Options**:
- A: Simple: { type: 'stdout'|'stderr'|'tool'|'complete', content: string, timestamp: Date }
- B: Structured: { type: string, data: unknown, metadata: { toolName?, filePath?, etc. } }
- C: Match Claude Code's native JSON output format exactly

**Answer**: *Pending*

### Q3: Human Decision Handling
**Context**: The spec mentions 'Handle human decisions' under Agency integration but doesn't specify the mechanism. This affects how the plugin communicates back when user input is needed.
**Question**: How should the plugin handle scenarios where Claude Code asks a question requiring human decision?
**Options**:
- A: Pause session and emit a special event, caller must call continueSession with answer
- B: Callback/webhook mechanism configured in InvokeOptions
- C: Queue decisions for batch review, continue with defaults

**Answer**: *Pending*

### Q4: Session Persistence
**Context**: Sessions support continue/end but it's unclear if sessions survive container restarts or are purely in-memory. This affects reliability and cost.
**Question**: Should sessions persist across container restarts, or are they ephemeral within a container lifecycle?
**Options**:
- A: Ephemeral: Session dies with container, caller must handle reconnection
- B: Persistent: Store session state externally, recreate container on continue
- C: Hybrid: Short-lived ephemeral, with explicit checkpoint/restore for long tasks

**Answer**: *Pending*

### Q5: Error Recovery Strategy
**Context**: The acceptance criteria mentions 'Error handling robust' but doesn't specify recovery behavior for common failures like container crashes or API timeouts.
**Question**: What error recovery behavior is expected for transient failures?
**Options**:
- A: Fail fast: Surface error immediately, caller handles retry
- B: Auto-retry: Built-in retry with exponential backoff for transient errors
- C: Checkpoint: Save progress periodically, allow resume from last checkpoint

**Answer**: *Pending*

