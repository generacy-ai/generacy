# Technical Research: Worker Event Forwarding

**Date**: 2026-02-17

## Key Findings from Codebase Analysis

### 1. Executor Event Emission is Synchronous

`ExecutionEventEmitter.emit()` (workflow-engine `executor/events.ts:50-58`) iterates over listeners synchronously. Each listener is called inline, wrapped in a try/catch. This means `EventForwarder.handleEvent()` **must not perform any async I/O** — it must return immediately.

**Implication**: The `handleEvent` method pushes events to an internal buffer. The actual HTTP flush is triggered either by a `setTimeout` callback (microtask) or by an explicit `flush()` call.

### 2. Executor Already Provides Duration and Result Data in Events

The executor includes full `PhaseResult`/`StepResult` objects in `event.data` for completion events:

- `phase:complete` → `event.data` = `PhaseResult` with `{ phaseName, status, startTime, endTime, duration, stepResults }` (executor/index.ts:347-354)
- `step:complete` → `event.data` = `StepResult` with `{ stepName, phaseName, status, startTime, endTime, duration, output, exitCode, error }` (executor/index.ts:467-476)
- `action:complete`/`action:error` → `event.data` = `{ attempts, totalDuration }` (executor/index.ts:532-546)

**Implication**: No need to independently track start timestamps for duration calculation. Extract `duration` from `event.data` directly.

### 3. `step:output` Content is in `event.message`, Not `event.data`

The executor emits `step:output` via `emitEvent('step:output', workflowName, { phaseName, stepName, message: actionResult.stdout })` (executor/index.ts:439-443). The stdout content is in `event.message`, not `event.data`.

**Implication**: The event mapper must read `event.message` for `step:output` events and place it into `data.output`.

### 4. Skipped Phases Don't Emit `phase:complete`

When a phase condition is not met, the executor returns a result with `status: 'skipped'` but does NOT emit a `phase:complete` or `phase:error` event (executor/index.ts:273-281 — returns early before the emit code at line 347). It does still emit `phase:start` before checking the condition.

**Implication**: For progress tracking, skipped phases won't naturally increment progress. The `EventForwarder` could either:
- (a) Ignore skipped phases — progress jumps from phase N to phase N+2. This is acceptable per Q4 default (count all phases as denominator).
- (b) Listen for the next `phase:start` and infer the gap. More complex.

Chosen approach: (a) — accept the jump. Progress is clamped and monotonically increasing.

### 5. HeartbeatManager Progress Update Path

`HeartbeatManager.setCurrentJob(jobId, progress)` sets both `this.currentJob` and `this.progress`. The next heartbeat cycle (every 30s by default) will include the progress value. There is no immediate heartbeat on progress change.

**Implication**: Progress updates are visible to the orchestrator with up to 30s latency (heartbeat interval). This is acceptable for heartbeat-based progress. Real-time progress is also conveyed via `phase:complete`/`step:complete` events forwarded to the event stream.

### 6. Potential Duplicate `job:status` Events

`JobHandler.executeJob()` calls `client.updateJobStatus(job.id, 'running')` at line 207. The orchestrator's `updateJobStatus` handler (server.ts:561+) publishes a `job:status` event via the event bus. The `EventForwarder` will also map `execution:start` to `job:status` with `{ status: 'running' }`.

This results in two `job:status` events with `running` status. Similarly, `reportJobResult()` triggers a status update, and `execution:complete` maps to another `job:status`.

**Implication**: The duplication is harmless — both carry the same semantic meaning, and the event bus assigns distinct monotonic IDs. No deduplication needed. If desired, `execution:start` and `execution:complete`/`execution:error` mappings could be skipped entirely since `updateJobStatus` and `reportJobResult` already handle status transitions. However, keeping them ensures the event stream is complete even if the status endpoints change.

### 7. Server Event Endpoint Validation

The `POST /api/jobs/:jobId/events` endpoint (server.ts:514-525) validates:
- `body.type` must be one of the 8 `JobEventType` values
- `body.data` must be a non-null, non-array object

The 8 valid types match exactly what the event mapper produces: `job:status`, `phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`, `action:error`, `log:append`.

**Implication**: No server-side changes needed for single-event publishing. The existing validation will accept all mapped events.

### 8. No Batch Endpoint on Server

The server only accepts single events. FR-005's batch endpoint would require server changes. Using client-side fan-out (`Promise.all` of individual `publishEvent` calls) avoids this entirely.

**Implication**: Batch efficiency is reduced (N HTTP calls instead of 1), but given events are buffered for 100ms and most batches will contain 1-5 events, the overhead is minimal. The `publishEvents()` helper on `OrchestratorClient` encapsulates this pattern.

### 9. AbortController Chain

`JobHandler.abortController` (job-handler.ts:76) is separate from `WorkflowExecutor.abortController` (executor/index.ts:79). The `JobHandler.cancelCurrentJob()` aborts its own controller, but this does NOT propagate to the executor's controller. The executor's cancellation is triggered independently via `executor.cancel()`.

**Implication**: The `EventForwarder` doesn't need to handle `JobHandler`-level cancellation directly. The executor will emit `execution:cancel` when its own abort fires, and the forwarder picks that up as a regular event.

### 10. `executor.addEventListener()` Return Type

Returns `{ dispose: () => void }`. Must call `dispose()` in the `finally` block to prevent memory leaks (listener referencing a completed job's forwarder would keep objects alive).
