# Clarification Questions

## Status: Pending

## Questions

### Q1: Executor Event Count Discrepancy
**Context**: The spec states the `WorkflowExecutor` emits "14 event types," but the actual `ExecutionEventType` definition in `packages/workflow-engine/src/types/events.ts` lists 15 types (including both `action:error` and `action:retry`). The mapping table in the spec also lists 15 rows. This inconsistency could cause a missed event type during implementation.
**Question**: Should the spec summary be corrected to say 15 event types, or is one of the listed types intentionally excluded?
**Options**:
- A) Correct to 15: Update the spec summary to "15 event types" — all types in `ExecutionEventType` are in scope
- B) Exclude one type: One of the listed event types is actually deprecated or should not be forwarded — clarify which one
**Answer**:

### Q2: Batch Endpoint — Server-Side Changes Required
**Context**: The spec assumes "no server-side changes needed" (Assumptions section) and marks server-side changes as "Out of Scope." However, the current `publishEvent` handler in `server.ts:499-556` only accepts a single event object via `parseJsonBody<{ type: string; data: unknown; timestamp?: number }>`. It validates that `data` is a non-array object. FR-005 requires `publishEvents()` to post an array of events, which the current endpoint will reject. This is a blocking contradiction.
**Question**: How should batch event publishing be implemented given the server endpoint only accepts single events?
**Options**:
- A) Modify server endpoint: Update `POST /api/jobs/:jobId/events` to also accept an array body (detect single vs. array) — requires server-side change
- B) New batch endpoint: Add `POST /api/jobs/:jobId/events/batch` as a separate route — requires server-side change
- C) Client-side fan-out: `publishEvents()` sends individual HTTP requests in parallel for each event in the batch, removing the need for server changes but reducing batch efficiency
- D) Defer batching: Remove FR-005 batch endpoint from this feature; use individual `publishEvent()` calls and add true batch support in a follow-up
**Answer**:

### Q3: HeartbeatManager Access from JobHandler
**Context**: The spec's `EventForwarder` constructor requires a `HeartbeatManager` instance to update progress (FR-006). However, `JobHandler` and `HeartbeatManager` are instantiated independently in `cli/commands/worker.ts` — `JobHandler` has no reference to `HeartbeatManager`. The spec's technical design doesn't address this wiring gap.
**Question**: How should `HeartbeatManager` be made accessible to the `EventForwarder` inside `JobHandler`?
**Options**:
- A) Add to JobHandlerOptions: Add an optional `heartbeatManager?: HeartbeatManager` field to `JobHandlerOptions` and pass it during worker bootstrap
- B) Progress callback: Add an `onProgress?: (progress: number) => void` callback to `JobHandlerOptions`, keeping `HeartbeatManager` decoupled from `JobHandler`
- C) Event-based: Emit progress events that the worker bootstrap code listens to and forwards to `HeartbeatManager`
**Answer**:

### Q4: Conditional Phase Execution and Progress Calculation
**Context**: `PhaseDefinition` has an optional `condition?: string` field, and `StepDefinition` also has `condition?: string`. Phases or steps may be skipped at runtime based on these conditions. The progress formula assumes `totalPhaseWeight = total number of phases in workflow`, but if phases are conditionally skipped, progress could jump unexpectedly (e.g., from 33% to 100% if phase 2 is skipped in a 3-phase workflow).
**Question**: How should skipped phases/steps affect progress calculation?
**Options**:
- A) Count all phases: Use total defined phases as denominator regardless of skipping — progress may jump but is simpler
- B) Adjust dynamically: Recalculate total phases at each phase boundary, excluding skipped ones — more accurate but adds complexity and risk of progress decreasing
- C) Mark skipped as complete: Treat skipped phases as instantly completed, incrementing progress smoothly
**Answer**:

### Q5: Error Event Data — Serialization of Error Objects
**Context**: The mapping table specifies that `execution:error`, `phase:error`, `step:error`, and `action:error` events should include `error` in their `data` payload. The `ExecutionEvent.data` field is typed as `unknown`, and errors could be `Error` objects (with non-serializable stack traces, circular references) or plain strings. The orchestrator's `publishEvent` endpoint requires `data` to be a JSON-serializable `Record<string, unknown>`.
**Question**: How should error objects be serialized when mapping executor events to job events?
**Options**:
- A) Message only: Extract `error.message` string and include as `{ error: error.message }`
- B) Message + stack: Include `{ error: error.message, stack: error.stack }` for debugging
- C) Full serialization: Attempt `JSON.stringify(error)` with a fallback to message-only if it fails
**Answer**:

### Q6: step:output Event — Data Size Limits
**Context**: `step:output` events carry stdout/stderr content that can be arbitrarily large (e.g., a build tool dumping thousands of lines). These get batched and sent via HTTP to the orchestrator, which stores them in a ring buffer. There's no mention of size limits or truncation in the spec, and large payloads could cause memory pressure, slow HTTP requests, or exceed server body size limits.
**Question**: Should `step:output` event data be truncated or size-limited before forwarding?
**Options**:
- A) No limit: Forward output as-is; rely on orchestrator ring buffer to manage storage
- B) Per-event limit: Truncate output to a configurable maximum (e.g., 64KB) per event, appending a "[truncated]" marker
- C) Aggregate limit: Track total output bytes per job and stop forwarding `step:output` after a threshold (e.g., 10MB)
**Answer**:

### Q7: Circuit Breaker State Visibility
**Context**: The spec defines a circuit breaker that pauses forwarding after 10 consecutive failures for 30 seconds (FR-007, US2). During this pause, events are silently dropped. There's no specification for how the circuit breaker state (open/closed, failure count, pause remaining) should be observable — e.g., should it be reported in heartbeats, emitted as a log event, or only visible in worker logs?
**Question**: How should the circuit breaker state be communicated to operators?
**Options**:
- A) Worker logs only: Log at `warn` level when circuit opens/closes — minimal implementation, sufficient for debugging
- B) Heartbeat metadata: Include circuit breaker state in heartbeat data so the orchestrator dashboard can display it
- C) Synthetic event: Emit a `log:append` event when the circuit breaker opens/closes (if the circuit is closed, naturally)
**Answer**:

### Q8: Event Ordering Guarantees in Batch Delivery
**Context**: The spec requires events to be buffered for up to 100ms before batch delivery (US4). During batching, events from different phases/steps may interleave. The orchestrator's `EventBus.publish()` assigns monotonic IDs sequentially. If a batch of events is delivered in a single HTTP call, they need to be published in the correct chronological order. The spec doesn't clarify whether event ordering within a batch must be preserved.
**Question**: Must events within a batch maintain their original emission order when published to the orchestrator?
**Options**:
- A) Strict ordering: Events in each batch must be published in emission order — the EventForwarder must maintain a FIFO buffer
- B) Type-grouped: Events can be grouped by type within a batch for processing efficiency, as long as per-type ordering is preserved
**Answer**:

### Q9: Flush Timing Relative to reportJobResult
**Context**: The spec states "any remaining buffered events are flushed before `reportJobResult()` is called" (US4-AC4, FR-008). However, if the circuit breaker is open when execution completes, the flush would fail or be skipped. This means the final `execution:complete` event (mapped to `job:status` with `status: 'completed'`) might not be delivered, even though the job result is reported successfully. This could leave monitoring clients showing an incomplete workflow.
**Question**: Should the final flush override the circuit breaker to ensure terminal events are delivered?
**Options**:
- A) Override circuit breaker: Always attempt to send terminal events (`execution:complete`, `execution:error`, `execution:cancel`) regardless of circuit breaker state
- B) Respect circuit breaker: If the circuit is open, skip the flush — the `reportJobResult()` call will update the job status anyway
- C) Retry terminal events: For terminal events only, retry up to 3 times with backoff before giving up
**Answer**:

### Q10: Handling Executor Events During Job Cancellation
**Context**: When a job is cancelled, `JobHandler` calls `executor.cancel()` which emits `execution:cancel`. But the cancellation path in `executeJob()` (lines 251-280) catches errors and may call `reportJobResult()` with a failure/cancelled status. The spec doesn't clarify whether the `EventForwarder` should still be flushed during the error/cancel path, or only in the success path.
**Question**: Should the EventForwarder flush be called in all exit paths (success, error, cancel), or only on success?
**Options**:
- A) All paths: Call `flush()` in a `finally` block before `reportJobResult()` in every exit path
- B) Success + cancel only: Flush on success and cancellation, but skip on unrecoverable errors where the orchestrator may be unreachable
**Answer**:

### Q11: Duration Tracking Responsibility
**Context**: FR-009 specifies adding `duration` to `phase:complete` and `step:complete` events by tracking start timestamps. However, the `WorkflowExecutor` already calculates and includes `duration` in `PhaseResult` and `StepResult` (see `execution.ts` types). The executor also emits `phase:complete` and `step:complete` events, but the `ExecutionEvent.data` field structure for these events needs verification — it's unclear whether the executor already includes duration in the event data or if the `EventForwarder` must independently track start times.
**Question**: Does the executor already include duration in `phase:complete`/`step:complete` event data, or must the EventForwarder compute it independently?
**Options**:
- A) Executor provides it: Check the executor emit code — if duration is already in `event.data`, just pass it through
- B) EventForwarder computes it: Track `phase:start`/`step:start` timestamps and calculate duration on completion events
- C) Both: Use executor-provided duration if available, fall back to EventForwarder calculation
**Answer**:

### Q12: Batch Endpoint Fallback Behavior
**Context**: FR-005 states `publishEvents()` "Falls back to individual calls if batch endpoint unavailable." This implies the client should detect whether the orchestrator supports batching and gracefully degrade. However, there's no versioning or capability negotiation mechanism defined. The fallback detection strategy (e.g., check HTTP 404, feature flag, config option) is unspecified.
**Question**: How should the client detect whether the orchestrator supports batch event publishing?
**Options**:
- A) Config flag: Add a `supportsBatchEvents` option to `OrchestratorClient` — simple, explicit, no runtime detection
- B) Probe on first call: Try the batch endpoint once; if it returns 404, fall back to individual calls for the rest of the session
- C) Always individual: Skip batch endpoint entirely for v1; send events individually but use client-side parallelism (Promise.all) for batches
**Answer**:

