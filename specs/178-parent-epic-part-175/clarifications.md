# Clarification Questions

## Status: Resolved

## Questions

### Q1: Streaming Event Granularity
**Context**: `stdout.on('data')` fires per OS buffer chunk (typically 4-64KB), which may contain many lines or partial lines. High-frequency per-chunk events could overwhelm the RingBuffer (default capacity 1000) and SSE connections during verbose Claude output. The spec does not address batching or throttling strategy.
**Question**: Should log events be emitted per raw chunk from the OS, or should they be batched/debounced (e.g., every 200-500ms) to reduce event volume?
**Options**:
- A) Per-chunk (raw): Emit a `log:append` event for every `data` callback from the child process. Simplest implementation, lowest latency, but highest event volume.
- B) Time-batched: Buffer chunks and emit a combined `log:append` event every N milliseconds (e.g., 200ms). Reduces event volume while keeping latency acceptable.
- C) Line-buffered: Split on newlines and emit one event per complete line. Semantically cleaner but adds complexity for partial lines and binary-like output.
**Answer**: B) Time-batched (200ms). The RingBuffer default capacity is 1000 events per job. A 5+ minute Claude invocation producing per-chunk events would blow through that instantly. Time-batching at ~200ms gives imperceptible latency for a log viewer while keeping event volume manageable (~300 events/minute max). Within each batch, content can include newlines naturally — the UI can split on `\n` for rendering.

### Q2: Event Type for Streaming Data — `step:output` vs `log:append`
**Context**: The spec uses `step:output` as the event type emitted from the workflow engine (Section 3: Speckit Operation Integration) but `log:append` in the orchestrator. Currently `step:output` is emitted once at step completion with the full buffered stdout. Repurposing it for incremental streaming changes its semantics. Meanwhile, `log:append` only exists in the orchestrator's `JobEventType` — not in the workflow engine's `ExecutionEventType`.
**Question**: Which event type should carry incremental streaming data from the workflow engine to the orchestrator?
**Options**:
- A) New `log:append` type in workflow engine: Add `log:append` to `ExecutionEventType`, keep `step:output` for post-completion full output. Clean separation but adds a new event type.
- B) Repurpose `step:output` for incremental streaming: Change `step:output` to emit per-chunk instead of once at completion. Reuses existing type but breaks current semantics.
- C) Use `step:output` internally, map to `log:append` at the JobHandler boundary: Keep workflow engine events unchanged, translate in the forwarding layer. Preserves both type systems but adds mapping complexity.
**Answer**: A) New `log:append` in workflow engine. `log:append` already exists in `JobEventType` in the orchestrator types. Adding it to `ExecutionEventType` creates a clean 1:1 mapping. `step:output` currently has clear semantics — emitted once after step completion carrying the full stdout as `message`. Incremental streaming uses `log:append`, post-completion summary uses `step:output`.

### Q3: JobHandler Event Forwarding Scope
**Context**: The `JobHandler` currently does NOT forward any executor events to the orchestrator's EventBus via `OrchestratorClient.publishEvent()`. The spec focuses on log streaming but doesn't address whether existing lifecycle events (`step:start`, `step:complete`, `phase:start`, etc.) should also be forwarded. These are already valid `JobEventType` values and the infrastructure exists.
**Question**: Should this feature also wire up forwarding of existing lifecycle events (step:start, step:complete, phase:start, phase:complete, action:error) from the executor to the orchestrator, or only log streaming events?
**Options**:
- A) Log streaming only: Only forward `log:append`/streaming events. Minimal scope, other event forwarding is a separate task.
- B) Forward all matching events: Wire up forwarding for all `ExecutionEventType` values that have a matching `JobEventType`. More complete but larger change.
- C) Forward lifecycle + logs: Forward lifecycle events (step/phase start/complete) plus log streaming, but skip action-level events. Balanced approach.
**Answer**: C) Forward lifecycle + logs. The `JobHandler` already listens to executor events but currently only tracks `step:error` and `phase:complete` for GitHub label management. The lifecycle event types already exist in both `ExecutionEventType` and `JobEventType`. Once forwarding infrastructure is built for log streaming, forwarding lifecycle events is trivial — just widen the filter. This is needed for the parent epic (#175 real-time workflow monitoring) anyway. Skip `action:*` events as they're too granular.

### Q4: RingBuffer Capacity for Log Events
**Context**: The EventBus uses a per-job `RingBuffer` with a default capacity of 1000 events. A single Claude invocation running for 5+ minutes can produce thousands of output lines. If log events share the same RingBuffer as lifecycle events, early log entries will be evicted, and lifecycle events (step:start, step:complete) could also be lost. The spec proposes a separate `LogBuffer` class but doesn't clarify its relationship to the existing EventBus RingBuffer.
**Question**: Should log events use a separate buffer from the existing EventBus RingBuffer, or should they share the same buffer with an increased capacity?
**Options**:
- A) Separate LogBuffer (as spec proposes): Create the new `LogBuffer` class with 10,000 entry capacity. Log events go to LogBuffer; lifecycle events stay in the EventBus RingBuffer. Requires separate endpoints for log retrieval.
- B) Shared buffer with increased capacity: Increase the EventBus RingBuffer capacity to 10,000+. Simpler architecture, single event stream, but lifecycle events could still be crowded out.
- C) Separate LogBuffer + EventBus passthrough: Log events stored in the dedicated LogBuffer AND broadcast via the existing EventBus SSE (but not stored in the EventBus RingBuffer). Retrieval via dedicated log endpoint, live streaming via existing SSE.
**Answer**: C) Separate LogBuffer + EventBus passthrough. The existing EventBus RingBuffer (1000 capacity) is sized for lifecycle events. Log events would drown out lifecycle events in a shared buffer. Option C provides: (1) dedicated LogBuffer with 10,000 capacity for historical retrieval, (2) lifecycle events preserved in the EventBus RingBuffer, and (3) live streaming of log events via existing SSE broadcast (without storing them in the EventBus RingBuffer). Reconnecting clients get lifecycle history from EventBus + log history from LogBuffer.

### Q5: Dedicated Log Endpoints vs Existing Event Endpoints
**Context**: The spec proposes new `POST /api/jobs/:jobId/logs` and `GET /api/jobs/:jobId/logs` endpoints. However, the existing `POST /api/jobs/:jobId/events` endpoint already accepts `log:append` events and the `GET /api/jobs/:jobId/events` SSE endpoint already streams all event types. Adding parallel endpoints creates two paths for the same data.
**Question**: Should we add dedicated log endpoints as the spec proposes, or reuse the existing event endpoints with filtering?
**Options**:
- A) Dedicated log endpoints (as spec proposes): New `POST` and `GET /api/jobs/:jobId/logs` endpoints with log-specific behavior (ring buffer, `?since=`, `?stream=true`). Clean API separation but duplicates some EventBus functionality.
- B) Reuse existing event endpoints: Post log events via `POST /api/jobs/:jobId/events` (already works), retrieve via `GET /api/jobs/:jobId/events?type=log:append`. No new endpoints, leverages existing infrastructure.
- C) Hybrid: Post via existing event endpoint, but add `GET /api/jobs/:jobId/logs` as a convenience endpoint that reads from the separate LogBuffer with log-specific query parameters.
**Answer**: C) Hybrid. `POST /api/jobs/:jobId/events` already accepts `log:append` events — no reason to duplicate the ingestion path. But retrieval is different: the dedicated LogBuffer needs its own `GET /api/jobs/:jobId/logs` endpoint with log-specific query params (`?since=`, `?stream=true`). The existing `GET /api/jobs/:jobId/events` SSE stream continues to work for live streaming of all event types including `log:append` passthrough.

### Q6: UTF-8 Multi-byte Character Handling
**Context**: The spec acknowledges that arbitrary `Buffer` boundaries may split multi-byte UTF-8 characters and states this is "acceptable for logging purposes." However, split characters produce invalid UTF-8 sequences that can cause rendering issues in the UI, corrupt JSON serialization, or break SSE event framing (SSE uses UTF-8 text).
**Question**: Should the implementation handle multi-byte character splitting, or accept potential rendering artifacts?
**Options**:
- A) Accept artifacts (as spec states): Use simple `data.toString()` and accept occasional garbled characters. Simplest implementation.
- B) Use StringDecoder: Use Node.js `string_decoder` module which properly handles multi-byte sequences across chunk boundaries. Minimal overhead, prevents garbled output.
**Answer**: B) Use StringDecoder. `StringDecoder` is built into Node.js, adds negligible overhead, and is one line of code change. Claude's output is UTF-8 text that may include non-ASCII characters. Garbled characters in SSE frames could break JSON serialization. No defensible reason to accept known-preventable corruption.

### Q7: Log Cleanup Grace Period and Trigger
**Context**: The spec mentions cleaning up log buffers when jobs reach terminal states (FR-010) and the existing EventBus has a 5-minute grace period for cleanup. However, the spec doesn't specify the grace period for log cleanup or whether it should align with the EventBus cleanup. The success criteria says "within 60s" but FR-010 says "use grace period."
**Question**: What grace period should be used before cleaning up log buffers after a job reaches a terminal state?
**Options**:
- A) Align with EventBus (5 minutes): Use the same 300-second grace period as the existing EventBus cleanup. Consistent behavior, gives reconnecting clients time to catch up.
- B) Shorter (60 seconds): Clean up faster as suggested by SC-005. Saves memory sooner but less time for late-connecting clients.
- C) Configurable with default: Make it configurable (like EventBus), defaulting to the EventBus grace period. Most flexible.
**Answer**: A) Align with EventBus (5 minutes). The EventBus already has a grace period mechanism with configurable duration (defaults to 300s). Using the same value for LogBuffer cleanup is consistent and predictable, gives reconnecting clients time to catch up, and memory impact of 5 minutes of log data is negligible. The SC-005 "within 60s" success criterion should be updated to match.

### Q8: `emitEvent` API Shape on ActionContext
**Context**: The spec proposes adding `emitEvent?: (event: { type: string; data: Record<string, unknown> }) => void` to `ActionContext`. The `type` field is typed as `string`, which allows arbitrary event types from action handlers. This could lead to unvalidated event types being emitted. Also, `emitEvent` is marked optional (`?`) meaning all existing code continues to work, but callers must null-check.
**Question**: Should `emitEvent` use a constrained type for the event type parameter, and should it be required or optional on ActionContext?
**Options**:
- A) Optional with string type (as spec proposes): `emitEvent?: (event: { type: string; ... }) => void`. Maximum flexibility, non-breaking, but no type safety on event names.
- B) Optional with union type: `emitEvent?: (event: { type: 'step:output' | 'log:append'; ... }) => void`. Type-safe event names, still optional for backward compatibility.
- C) Required callback: Make `emitEvent` required (always provided by executor). Avoids null-checks in every caller, but requires changes to all ActionContext creation sites.
**Answer**: B) Optional with union type. Type safety on event names catches bugs at compile time. The union type `'log:append' | 'step:output'` constrains what actions can emit — actions shouldn't be inventing arbitrary event types. Keeping it optional maintains backward compatibility. The union type can be extended as new event types are added.

### Q9: `executeShellCommand` Streaming Priority
**Context**: FR-003 adds streaming to `executeShellCommand()` at P2 priority, while `executeCommand()` is P1. The spec doesn't clarify whether `executeShellCommand` is currently used for any Claude or long-running operations, or only for short commands. If it's only used for quick shell operations (like `gh` commands), streaming may not provide value.
**Question**: Is `executeShellCommand()` used for any long-running operations that would benefit from streaming, or can FR-003 be deferred without impact?
**Options**:
- A) Include in initial scope: Implement streaming for both functions together since the pattern is identical and it's a small incremental effort.
- B) Defer to follow-up: Skip `executeShellCommand` streaming initially. Implement only if a concrete use case arises.
**Answer**: B) Defer. `executeShellCommand` is used in speckit operations for short-lived commands like `gh` CLI calls and file system operations. These complete in seconds. No current use case where streaming their output provides value. The pattern from `executeCommand` is trivially replicable if needed later. Keep the PR focused.

### Q10: Implement Operation — Per-Task Streaming Identity
**Context**: The `implement` operation iterates through multiple tasks, calling `executeCommand('claude', ...)` for each task sequentially. The spec's design shows `stepName: 'implement'` in the streaming callback, but doesn't distinguish between the individual task iterations within the implement step. Without a task identifier, all implement output appears as one undifferentiated stream.
**Question**: Should streaming output from the implement operation include a task identifier to distinguish output from different task iterations?
**Options**:
- A) Step-level only: Use `stepName: 'implement'` for all implement output. Simple, consistent with other operations.
- B) Include task identifier: Add `taskId` or `taskIndex` to the log entry data (e.g., `{ stepName: 'implement', taskIndex: 2, taskTitle: 'Add error handling' }`). Enables per-task output grouping in the UI.
**Answer**: B) Include task identifier. Without a task identifier, a 10-task implementation appears as one undifferentiated stream — making it impossible to tell which task is executing or find output for a specific task. Adding `taskIndex` and `taskTitle` to the log entry data is trivial (the implement loop already has this information) and essential for the monitoring UI.

### Q11: Error Handling for Event Posting Failures
**Context**: The event flow has the worker posting log events to the orchestrator via HTTP (`POST /api/jobs/:jobId/events`). The spec doesn't address what happens if these HTTP calls fail (network issues, orchestrator restart, rate limiting). Failed event posts could cause log data loss or, worse, slow down the actual Claude process if posting is synchronous.
**Question**: How should the worker handle failures when posting log events to the orchestrator?
**Options**:
- A) Fire-and-forget: Post events asynchronously without awaiting. If a post fails, the log entry is lost. Prioritizes process execution speed over log completeness.
- B) Async queue with retry: Buffer events in an async queue with limited retries (e.g., 2 retries with backoff). Resilient to transient failures without blocking the process.
- C) Async queue, drop on overflow: Buffer up to N events; if the queue fills (orchestrator down), silently drop oldest events. Bounded memory, no blocking.
**Answer**: C) Async queue, drop on overflow. The critical constraint is that log event posting must never block or slow the Claude process. An async queue with bounded capacity (e.g., 100 events) absorbs transient network hiccups, and dropping oldest on overflow provides graceful degradation if the orchestrator is down — bounded memory, no blocking, no unbounded retries. Standard pattern for non-critical telemetry.

### Q12: Testing Strategy
**Context**: The spec lists files to modify and success criteria but doesn't describe the testing approach. The changes span two packages (workflow-engine and generacy), involve child process mocking, SSE testing, and timing-sensitive behavior. The existing test infrastructure and patterns should inform the approach.
**Question**: What testing approach should be used for this feature?
**Options**:
- A) Unit tests only: Test `executeCommand` callbacks, `LogBuffer` class, and endpoint handlers in isolation with mocks. Fast, focused, but doesn't verify end-to-end flow.
- B) Unit + integration: Unit tests for individual components plus integration tests that spawn a real child process and verify events arrive via SSE. More comprehensive but slower.
- C) Unit + integration + E2E: Add Playwright-based E2E tests that verify log output appears in the frontend. Most complete but depends on frontend implementation (which is out of scope).
**Answer**: B) Unit + integration. Unit tests for individual components (workflow-engine: `executeCommand` callbacks, event emission; orchestrator: LogBuffer, endpoint handlers, SSE) plus integration tests that spawn a real short-lived process and verify events arrive via SSE endpoint. This validates end-to-end flow without depending on frontend (out of scope) or requiring Playwright E2E.
