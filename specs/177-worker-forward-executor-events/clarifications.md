# Clarification Questions

## Status: Pending

## Questions

### Q1: Duplicate `job:status` Events from `execution:*` Mapping
**Context**: The spec maps `execution:start` to `job:status { status: 'running' }` and `execution:complete`/`execution:error`/`execution:cancel` to terminal `job:status` events. However, `JobHandler.executeJob()` already calls `client.updateJobStatus(job.id, 'running')` before `executor.execute()`, and the server's `PUT /api/jobs/:jobId/status` handler auto-publishes a `job:status` event via EventBus (server.ts:587-593). Similarly, `reportJobResult` triggers a terminal status update. Forwarding these `execution:*` events as `job:status` would produce duplicate events on the SSE stream, and terminal duplicates could trigger `closeJobSubscribers`/`scheduleCleanup` twice.
**Question**: Should the EventForwarder skip forwarding `execution:start`, `execution:complete`, `execution:error`, and `execution:cancel` events (since they duplicate existing status updates), or should we remove the existing `updateJobStatus` call and let the EventForwarder be the sole source of `job:status` events?
**Options**:
- A) Skip `execution:*` events: The EventForwarder should not forward `execution:start/complete/error/cancel` as `job:status` events. The existing `updateJobStatus` and `reportJobResult` calls remain the authoritative source for job status transitions. This avoids duplicate events and double-cleanup of SSE subscribers.
- B) Forward but deduplicate server-side: Forward all events including `execution:*`, and add server-side deduplication to ignore `job:status` events when the job is already in that status.
- C) Replace existing calls: Remove the explicit `updateJobStatus('running')` call and make the EventForwarder the sole publisher of `job:status` events. This is a larger refactor but eliminates redundancy.
**Answer**:

---

### Q2: HeartbeatManager Access from JobHandler
**Context**: The spec assumes "The `HeartbeatManager` instance is accessible from `JobHandler`" (Assumptions section), but the current `JobHandlerOptions` interface does not include a `heartbeatManager` field. In the worker command (worker.ts:146-170), `HeartbeatManager` and `JobHandler` are separate objects — the heartbeat is only touched via `onJobStart`/`onJobComplete` callbacks (e.g., `heartbeatManager.setCurrentJob(job.id)`). The EventForwarder needs access to `HeartbeatManager.setCurrentJob(jobId, progress)` to update progress on each `phase:complete` event.
**Question**: How should the EventForwarder get access to the HeartbeatManager for progress updates?
**Options**:
- A) Add `heartbeatManager` to `JobHandlerOptions`: Pass the `HeartbeatManager` instance directly into `JobHandler` via its options, so the EventForwarder can call `setCurrentJob(jobId, progress)` during execution. This changes the `JobHandlerOptions` interface.
- B) Use a progress callback: Add an `onProgress?: (jobId: string, progress: number) => void` callback to `JobHandlerOptions`. The worker command wires it to `heartbeatManager.setCurrentJob(jobId, progress)`. This keeps JobHandler decoupled from HeartbeatManager.
- C) Pass HeartbeatManager to EventForwarder directly: Instead of going through JobHandler, have the worker command create the EventForwarder itself, passing both the executor and heartbeat manager. This moves wiring responsibility out of JobHandler.
**Answer**:

---

### Q3: Total Phase Count Source for Progress Calculation
**Context**: The spec says "On `execution:start`: record total phase count from the workflow definition (available in `event.data`)" (Design Notes > Progress Calculation). However, inspecting the executor source (workflow-engine/src/executor/index.ts:157-159), the `execution:start` event is emitted with only `{ message: 'Starting workflow: ...' }` — it does not include phase count data. The total phase count is available from the workflow definition object (`workflow.phases.length`) which is loaded in `JobHandler.executeJob()` before calling `executor.execute()`.
**Question**: Where should the EventForwarder get the total phase count for progress calculation?
**Options**:
- A) Pass workflow definition to EventForwarder: The EventForwarder constructor accepts the parsed workflow definition (or just `totalPhases: number`) so it can compute progress. JobHandler passes this when creating the EventForwarder after loading the workflow.
- B) Infer from events: Count `phase:start` events and estimate total from the workflow metadata attached to each event. This is fragile because the total isn't known until execution completes.
- C) Modify executor to include phase count in `execution:start` data: Update the workflow-engine to include `{ totalPhases, phaseNames }` in the `execution:start` event data. This changes the workflow-engine package.
**Answer**:

---

### Q4: Batch Flush Semantics — Parallel vs. Sequential
**Context**: The spec says "Each flush sends events individually via `publishEvent` (the orchestrator API accepts one event per call) but can be parallelized with `Promise.allSettled`" (Design Notes > Batching Strategy). However, parallelizing event posts means the orchestrator may receive them out of order if some requests are faster than others. For monitoring clients showing real-time progress, receiving `step:complete` before `step:start` would be confusing.
**Question**: Should batched events be sent in parallel (faster but potentially out-of-order) or sequentially (preserves ordering but slower)?
**Options**:
- A) Sequential within a batch: Send events one at a time using a `for...of` loop with `await`. This guarantees ordering at the cost of higher latency per batch flush.
- B) Parallel with sequence numbers: Send in parallel via `Promise.allSettled` and add a `sequence: number` field to each event's data payload. The orchestrator or client can reorder if needed.
- C) Parallel, accept possible reordering: Send in parallel for performance. Minor reordering is acceptable since each event has a `timestamp` field that clients can sort by.
**Answer**:

---

### Q5: Error Data Serialization for Forwarded Events
**Context**: The spec's mapping table shows error events forwarding `{ error: message }` in the data payload. However, `ExecutionEvent.data` is typed as `unknown` and may contain rich error objects with stack traces, nested errors, or circular references. The `publishEvent` API sends data as JSON in a POST body, so the data must be JSON-serializable.
**Question**: How should error data be serialized when forwarding error events?
**Options**:
- A) Message only: Extract `error.message` (or `String(error)`) and forward only the string message. Simple and safe, but loses context like stack traces.
- B) Structured extraction: Extract `{ message, code, stack? }` from error objects. Include stack traces in non-production environments only. Truncate to a reasonable limit (e.g., 4KB).
- C) Best-effort JSON: Attempt `JSON.stringify(event.data)` with a replacer that handles circular references, falling back to `String(event.data)` on failure. Forwards whatever the executor provides.
**Answer**:

---

### Q6: EventForwarder Lifecycle — Per-Job or Shared
**Context**: The spec says to "Create `EventForwarder` class" (FR-009) and the design notes describe a `connect()`/`dispose()` lifecycle. However, it's unclear whether a new `EventForwarder` instance should be created for each job execution or whether a single instance should be reused across jobs (resetting its state between jobs).
**Question**: Should the EventForwarder be created fresh for each job or reused across jobs?
**Options**:
- A) Per-job instance (Recommended): Create a new `EventForwarder` for each `executeJob()` call. The instance holds the current `jobId`, progress state, and batch buffer. Dispose it in the `finally` block. Simple, no state leakage between jobs.
- B) Shared singleton: Create one `EventForwarder` in the worker command and pass it to JobHandler. Call `connect(executor, jobId)` at the start of each job and `disconnect()` at the end. Avoids repeated allocation but requires careful state reset.
**Answer**:

---

### Q7: Step-Level Progress Granularity
**Context**: The spec mentions "optional step-level granularity within a phase" for progress calculation (US3 acceptance criteria and Design Notes). The formula `phaseBase + (completedSteps / totalSteps) * phaseWeight` requires knowing the total number of steps per phase. This information is available from the workflow definition but adds complexity to the progress tracking logic.
**Question**: Should the initial implementation include step-level progress granularity, or just phase-level?
**Options**:
- A) Phase-level only: Progress = `(completedPhases / totalPhases) * 100`. Simple, no per-phase step counting needed. Progress jumps in discrete increments when each phase completes.
- B) Step-level granularity: Progress smoothly interpolates within each phase based on step completion. Requires tracking total steps per phase from the workflow definition. Provides a better UX for phases with many steps.
**Answer**:

---

### Q8: Buffer Size Limit and Backpressure
**Context**: The spec specifies a 100ms time-based flush and a 20-event buffer cap for deferred events (Design Notes > Batching Strategy). However, it doesn't address what happens if event publishing is slow and the buffer fills faster than it can be drained — e.g., if the orchestrator is responding slowly and 100+ `step:output` events arrive in a burst. Without backpressure, the buffer could grow unboundedly.
**Question**: Should the EventForwarder implement backpressure or a hard buffer limit to prevent unbounded memory growth?
**Options**:
- A) Hard cap with drop: Set a maximum buffer size (e.g., 100 events). If the buffer is full, drop the oldest deferred events and log a warning. Priority events still flush immediately.
- B) Hard cap with backpressure: If the buffer exceeds the cap, temporarily stop accepting deferred events until the current flush completes. This could delay the executor's synchronous listener call.
- C) No cap needed: Trust that the 100ms flush interval and 20-event threshold are sufficient. The executor won't produce more than ~100 events per second in practice.
**Answer**:

---

### Q9: `log:append` Data Payload Structure
**Context**: The spec maps `action:start`, `action:complete`, and `action:retry` to the `log:append` JobEventType, but the orchestrator's event validation only checks that `data` is a non-null object — it doesn't enforce a schema for `log:append` payloads. The spec shows different data shapes for each (e.g., `action:retry` includes `retryAttempt` and `maxRetries`). There's no existing convention for what `log:append` data should look like since it hasn't been used before.
**Question**: What structure should `log:append` event data follow?
**Options**:
- A) Simple message format: `{ message: string, level?: 'info' | 'warn', source?: string }`. All action events are reduced to a human-readable message string. Consistent and simple for clients to render.
- B) Typed action format: `{ actionType: 'start' | 'complete' | 'retry', stepName, phaseName, ...actionSpecificFields }`. Preserves the original event's semantic meaning. More useful for programmatic consumers.
- C) Passthrough with message: `{ message: string, ...event.data }`. Include a formatted message plus any extra data from the original event. Flexible but less predictable for clients.
**Answer**:
