# Feature Specification: Worker — Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17 | **Status**: Draft

## Summary

The `WorkflowExecutor` emits 15 event types (`execution:start`, `phase:start`, `step:complete`, `step:output`, `action:retry`, etc.) via its `ExecutionEventEmitter`, but these events are silently discarded in the worker process. This feature subscribes to executor events in `JobHandler.executeJob()`, maps them to the orchestrator's `JobEventType` schema, and forwards them via the existing `POST /api/jobs/:jobId/events` endpoint. Event forwarding is non-blocking and optionally batched to avoid flooding the orchestrator during high-frequency events.

## User Stories

### US1: Real-time Workflow Monitoring

**As a** monitoring client (dashboard or CLI),
**I want** to receive phase-level and step-level events as a workflow executes,
**So that** I can display real-time progress and diagnostics for running jobs.

**Acceptance Criteria**:
- [ ] All phase events (`phase:start`, `phase:complete`) are forwarded to the orchestrator
- [ ] All step events (`step:start`, `step:complete`, `step:output`) are forwarded to the orchestrator
- [ ] Action errors and retries are forwarded to the orchestrator
- [ ] Events are visible via the existing SSE stream (`GET /api/jobs/:jobId/events`)

### US2: Non-disruptive Event Forwarding

**As a** worker operator,
**I want** event forwarding failures to be silently logged without affecting job execution,
**So that** network hiccups or orchestrator outages do not cause job failures.

**Acceptance Criteria**:
- [ ] A failed `publishEvent` call does not throw or interrupt `executor.execute()`
- [ ] Forwarding errors are logged at `warn` level
- [ ] Job execution completes normally even if all event forwarding calls fail

### US3: Accurate Progress Reporting

**As a** monitoring client,
**I want** the worker heartbeat to reflect actual phase/step completion percentage,
**So that** I can show meaningful progress bars instead of a static 0-100 guess.

**Acceptance Criteria**:
- [ ] Heartbeat `progress` updates as phases and steps complete
- [ ] Progress is computed as `(completed phases / total phases) * 100` (with optional step-level granularity within a phase)
- [ ] Progress reaches 100 only when all phases complete

### US4: Event Batching Under Load

**As a** system operator,
**I want** high-frequency events (e.g., rapid `step:output` bursts) to be batched,
**So that** the orchestrator is not overwhelmed with individual HTTP requests.

**Acceptance Criteria**:
- [ ] Events are buffered for up to 100ms before sending as a batch
- [ ] Important events (`phase:start`, `phase:complete`, `step:complete`, errors) flush the buffer immediately
- [ ] The buffer is always flushed when the workflow execution ends (complete, error, or cancel)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Subscribe to all executor events in `JobHandler.executeJob()` via `executor.addEventListener()` before calling `executor.execute()` | P1 | Listener must be registered before execute so no events are missed |
| FR-002 | Map `ExecutionEventType` to `JobEventType` per the mapping table below | P1 | Some executor events have no direct counterpart and must be mapped or dropped |
| FR-003 | Forward mapped events to orchestrator via existing `OrchestratorClient.publishEvent()` | P1 | Calls `POST /api/jobs/:jobId/events` |
| FR-004 | Swallow and log all forwarding errors — never let them propagate to executor | P1 | Use `try/catch` around each `publishEvent` call; log at `warn` level |
| FR-005 | Dispose the event listener after `executor.execute()` resolves (success or error) | P1 | Use the `{ dispose }` handle returned by `addEventListener` |
| FR-006 | Compute heartbeat progress from phase/step completion counts | P2 | Update `HeartbeatManager.setCurrentJob(jobId, progress)` as `phase:complete` / `step:complete` events fire |
| FR-007 | Buffer events for up to 100ms and send as a batch to reduce HTTP overhead | P2 | Flush immediately for priority events; always flush on execution end |
| FR-008 | Extract timing/duration data from executor events and include in forwarded event `data` | P2 | Compute duration as delta between `start` and `complete` timestamps for each phase/step |
| FR-009 | Create `EventForwarder` class (or similar) to encapsulate forwarding, mapping, batching, and progress logic | P2 | Keeps `JobHandler` clean; follows the `ExecutorEventBridge` pattern from the VS Code extension |

## Event Type Mapping

The executor emits 15 `ExecutionEventType` values. The orchestrator accepts 8 `JobEventType` values. The mapping is:

| ExecutionEventType | JobEventType | Data payload | Notes |
|---|---|---|---|
| `execution:start` | `job:status` | `{ status: 'running' }` | Mirrors the `updateJobStatus('running')` call |
| `execution:complete` | `job:status` | `{ status: 'completed' }` | Terminal — triggers SSE subscriber cleanup |
| `execution:error` | `job:status` | `{ status: 'failed', error: message }` | Terminal |
| `execution:cancel` | `job:status` | `{ status: 'cancelled' }` | Terminal |
| `phase:start` | `phase:start` | `{ phaseName, workflowName }` | Direct mapping |
| `phase:complete` | `phase:complete` | `{ phaseName, workflowName, duration }` | Direct mapping |
| `phase:error` | `phase:complete` | `{ phaseName, workflowName, error: message, status: 'failed' }` | Mapped to `phase:complete` with error data |
| `step:start` | `step:start` | `{ stepName, phaseName, workflowName }` | Direct mapping |
| `step:complete` | `step:complete` | `{ stepName, phaseName, workflowName, duration }` | Direct mapping |
| `step:error` | `step:complete` | `{ stepName, phaseName, error: message, status: 'failed' }` | Mapped to `step:complete` with error data |
| `step:output` | `step:output` | `{ stepName, phaseName, message, data }` | Direct mapping |
| `action:start` | `log:append` | `{ stepName, phaseName, message: 'Action started' }` | No direct counterpart; logged |
| `action:complete` | `log:append` | `{ stepName, phaseName, message: 'Action completed' }` | No direct counterpart; logged |
| `action:error` | `action:error` | `{ stepName, phaseName, error: message, data }` | Direct mapping |
| `action:retry` | `log:append` | `{ stepName, phaseName, message, retryAttempt, maxRetries }` | Mapped to log entry |

## Integration Points

### Source: WorkflowExecutor (workflow-engine)
- `executor.addEventListener(listener)` returns `{ dispose(): void }`
- Listener receives `ExecutionEvent { type, timestamp, workflowName, phaseName?, stepName?, message?, data? }`
- Listener is called synchronously from the executor; forwarding must be async fire-and-forget

### Sink: OrchestratorClient (generacy)
- `client.publishEvent(jobId, { type: JobEventType, data: Record<string, unknown>, timestamp?: number })` — already implemented
- Posts to `POST /api/jobs/:jobId/events` on the orchestrator server
- Server validates `type` against allowed `JobEventType` values and publishes to EventBus for SSE broadcast

### HeartbeatManager (generacy)
- `heartbeat.setCurrentJob(jobId, progress)` — already accepts a `progress?: number` parameter
- Currently never called with a progress value during execution; this feature wires it up

## Files to Modify

| File | Change |
|------|--------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Subscribe to executor events before `execute()`; wire up `EventForwarder`; update heartbeat progress |
| `packages/generacy/src/orchestrator/event-forwarder.ts` | **New file** — `EventForwarder` class: event mapping, batching, error handling, progress tracking |
| `packages/generacy/src/orchestrator/types.ts` | Re-export `ExecutionEvent` and `ExecutionEventType` from workflow-engine (if needed for type sharing) |

Files that require **no changes** (already implemented):
- `packages/generacy/src/orchestrator/client.ts` — `publishEvent()` already exists
- `packages/generacy/src/orchestrator/server.ts` — `POST /api/jobs/:jobId/events` endpoint already exists
- `packages/generacy/src/orchestrator/event-bus.ts` — EventBus already handles publishing and SSE broadcast
- `packages/generacy/src/orchestrator/heartbeat.ts` — `setCurrentJob()` already accepts progress

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event forwarding coverage | 100% of executor events mapped and forwarded | Unit test: emit each of the 15 event types and verify `publishEvent` is called with correct `JobEventType` |
| SC-002 | Non-blocking guarantee | 0 job failures caused by event forwarding | Integration test: stub `publishEvent` to reject; verify job still completes |
| SC-003 | Heartbeat progress accuracy | Progress reflects actual phase completion | Unit test: emit `phase:complete` events and verify `setCurrentJob` is called with correct percentage |
| SC-004 | Batch efficiency | High-frequency events batched into fewer HTTP calls | Unit test: emit 50 `step:output` events in <100ms; verify fewer than 50 `publishEvent` calls |
| SC-005 | Listener cleanup | Listener disposed after every execution | Unit test: verify `dispose()` called in both success and error paths |

## Assumptions

- The orchestrator's `POST /api/jobs/:jobId/events` endpoint is deployed and operational (implemented in #176)
- The `WorkflowExecutor.addEventListener()` API is stable and won't change during this work
- Event ordering within a single HTTP request is preserved by the EventBus
- The orchestrator can handle the event volume from a single worker without rate limiting (batching is a best-effort optimization, not a hard requirement)
- The `HeartbeatManager` instance is accessible from `JobHandler` (either passed via options or available on the same scope in the worker command)

## Out of Scope

- **Orchestrator-side changes**: The `POST /api/jobs/:jobId/events` endpoint and SSE broadcast are already implemented (#176)
- **Client-side SSE consumption**: Dashboard or CLI subscribing to the event stream is a separate concern
- **Persistent event storage**: Events are kept in an in-memory ring buffer on the orchestrator; durable storage is a future concern
- **WebSocket transport**: This feature uses REST; a future optimization could use WebSocket for lower-latency bidirectional streaming
- **Multi-worker event ordering**: Global ordering guarantees across multiple workers are not addressed
- **Event filtering/suppression configuration**: All events are forwarded; per-event-type opt-in/opt-out is not part of this feature
- **Retry logic for failed event posts**: Failed forwarding calls are logged and dropped, not retried (the job's final result already contains phase/step summaries)

## Design Notes

### EventForwarder Pattern
Follow the `ExecutorEventBridge` pattern from `packages/generacy-extension/src/views/local/debugger/event-bridge.ts`. Create an `EventForwarder` class that:
1. Accepts `executor`, `client`, `jobId`, and optionally `heartbeatManager`
2. Calls `executor.addEventListener()` in its `connect()` method
3. Maps events synchronously, then fires async `publishEvent` calls without awaiting in the listener
4. Tracks phase/step counts for progress calculation
5. Exposes `dispose()` to clean up the listener and flush any pending batch

### Batching Strategy
- Maintain a `pendingEvents: Array` buffer
- On each event: push to buffer, then check priority
- **Immediate flush** for: `phase:start`, `phase:complete`, `step:complete`, `execution:*`, `*:error`
- **Deferred flush** for: `step:output`, `action:start`, `action:complete`, `action:retry`
- Deferred flush fires after 100ms timeout or when buffer reaches 20 events
- Each flush sends events individually via `publishEvent` (the orchestrator API accepts one event per call) but can be parallelized with `Promise.allSettled`

### Progress Calculation
- On `execution:start`: record total phase count from the workflow definition (available in `event.data`)
- On `phase:complete`/`phase:error`: increment completed phase count
- Progress = `Math.round((completedPhases / totalPhases) * 100)`
- Optionally: within a phase, use step-level progress for finer granularity: `phaseBase + (completedSteps / totalSteps) * phaseWeight`

---

*Generated by speckit*
