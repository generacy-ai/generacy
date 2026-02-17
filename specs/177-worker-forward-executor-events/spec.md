# Feature Specification: Worker — Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17 | **Status**: Draft

## Summary

The `WorkflowExecutor` emits 15 event types (`execution:start`, `phase:start`, `step:complete`, `step:output`, `action:retry`, etc.) via `ExecutionEventEmitter`, but these events are silently discarded — no listener is attached in `JobHandler.executeJob()`. This feature subscribes to those events in the worker and forwards them to the orchestrator via the existing `POST /api/jobs/:jobId/events` endpoint, enabling real-time workflow monitoring through the SSE infrastructure already built in #189.

## Current State

- **WorkflowExecutor** (`packages/workflow-engine/src/executor/index.ts`) emits events via `ExecutionEventEmitter` throughout execution (phases, steps, actions).
- **JobHandler** (`packages/generacy/src/orchestrator/job-handler.ts`) creates the executor and calls `executor.execute()` but never calls `executor.addEventListener()`. All events are lost.
- **OrchestratorClient** (`packages/generacy/src/orchestrator/client.ts`) already exposes `publishEvent(jobId, event)` which POSTs to `/api/jobs/:jobId/events`.
- **Orchestrator server** (`packages/generacy/src/orchestrator/server.ts`) already accepts `POST /api/jobs/:jobId/events`, validates event types, buffers events in `EventBus` ring buffers, and broadcasts to SSE subscribers.
- **HeartbeatManager** (`packages/generacy/src/orchestrator/heartbeat.ts`) sends periodic heartbeats with a `progress` field (0–100), but progress is never updated during execution — it stays at whatever was last set.

The orchestrator-side infrastructure is fully operational. The only gap is on the **worker side**: attaching a listener, mapping event types, and calling `publishEvent()`.

## User Stories

### US1: Real-Time Workflow Monitoring

**As a** monitoring client (frontend or API consumer),
**I want** to receive phase-level and step-level events in real-time as a workflow executes,
**So that** I can display live progress, logs, and status for running jobs.

**Acceptance Criteria**:
- [ ] All 15 executor event types are forwarded to the orchestrator as appropriate `JobEventType` events
- [ ] Events appear on the SSE stream (`GET /api/jobs/:jobId/events`) within 200ms of emission
- [ ] Events include workflow context (phase name, step name) and timing data

### US2: Non-Blocking Event Forwarding

**As a** workflow operator,
**I want** event forwarding failures to never interrupt or fail a running job,
**So that** transient network issues between worker and orchestrator don't cause workflow failures.

**Acceptance Criteria**:
- [ ] If `publishEvent()` throws, the error is logged but the job continues unaffected
- [ ] The executor's event loop is not blocked by HTTP calls (fire-and-forget pattern)
- [ ] A sustained orchestrator outage during execution does not degrade job reliability

### US3: Accurate Progress Tracking

**As a** monitoring client,
**I want** the heartbeat progress percentage to reflect actual workflow completion (phases/steps done vs total),
**So that** progress bars and status indicators are meaningful rather than static.

**Acceptance Criteria**:
- [ ] Heartbeat `progress` updates as phases and steps complete
- [ ] Progress reaches 100 only when execution completes successfully
- [ ] Progress calculation accounts for the number of phases and steps in the workflow

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Subscribe to executor events in `JobHandler.executeJob()` using `executor.addEventListener()` | P1 | Attach listener before calling `executor.execute()` |
| FR-002 | Map `ExecutionEventType` to `JobEventType` for each forwarded event | P1 | See type mapping table below |
| FR-003 | Call `client.publishEvent(jobId, mappedEvent)` for each executor event | P1 | Use existing client method |
| FR-004 | Wrap `publishEvent()` calls in try/catch — log errors, never throw | P1 | Non-blocking; fire-and-forget |
| FR-005 | Package `ExecutionEvent.data` into `JobEvent.data` record with relevant context | P1 | Include phaseName, stepName, message, duration where available |
| FR-006 | Batch rapid events (≤100ms window) into single HTTP calls to reduce request volume | P2 | Flush immediately for terminal/milestone events |
| FR-007 | Update `HeartbeatManager.setCurrentJob()` progress based on phase/step completion | P2 | Calculate percentage from completed vs total phases/steps |
| FR-008 | Include timing information (duration) in completed phase/step events | P1 | Computed from start→complete timestamp deltas |
| FR-009 | Remove the event listener (via disposable) after execution completes or errors | P1 | Prevent memory leaks |

### Event Type Mapping

The `ExecutionEventType` (15 types from workflow-engine) maps to `JobEventType` (8 types in orchestrator) as follows:

| ExecutionEventType | → JobEventType | Rationale |
|---|---|---|
| `execution:start` | `job:status` | Signals job has begun executing |
| `execution:complete` | `job:status` | Signals successful completion |
| `execution:error` | `job:status` | Signals failure with error details |
| `execution:cancel` | `job:status` | Signals cancellation |
| `phase:start` | `phase:start` | Direct mapping |
| `phase:complete` | `phase:complete` | Direct mapping |
| `phase:error` | `phase:complete` | Phase ended with error; include error in data |
| `step:start` | `step:start` | Direct mapping |
| `step:complete` | `step:complete` | Direct mapping |
| `step:error` | `action:error` | Step-level error detail |
| `step:output` | `step:output` | Direct mapping |
| `action:start` | `log:append` | Action-level detail as log entry |
| `action:complete` | `log:append` | Action-level detail as log entry |
| `action:error` | `action:error` | Direct mapping |
| `action:retry` | `log:append` | Retry attempt as log entry |

### Event Data Payload

Each forwarded event's `data` field should include all available context from the `ExecutionEvent`:

```typescript
{
  workflowName: event.workflowName,
  phaseName: event.phaseName,       // when applicable
  stepName: event.stepName,         // when applicable
  message: event.message,           // when applicable
  duration: computedDuration,       // for :complete events (ms)
  error: event.data?.error,         // for :error events
  ...event.data,                    // pass through any additional data
}
```

### Batching Strategy (FR-006)

Events are buffered for up to 100ms before sending as a batch. Exceptions that trigger immediate flush:

- `execution:*` (all execution-level events)
- `phase:start`, `phase:complete`
- `step:complete`
- Any `:error` event

For the initial implementation, batching is optional — individual event forwarding is acceptable if latency is low enough.

### Progress Calculation (FR-007)

Progress is computed as a weighted average of phase completion:

```
progress = (completedPhases / totalPhases) * 100
```

Within a phase, sub-progress can be interpolated from step completion:

```
phaseProgress = completedSteps / totalStepsInPhase
effectiveCompletedPhases = completedPhases + phaseProgress
progress = (effectiveCompletedPhases / totalPhases) * 100
```

The total phase/step counts come from the workflow definition loaded in `executeJob()`. Progress is updated on every `phase:complete` and `step:complete` event via `heartbeatManager.setCurrentJob(jobId, progress)`.

## Files to Modify

| File | Changes |
|------|---------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Attach event listener to executor; map and forward events; update heartbeat progress |
| `packages/generacy/src/orchestrator/types.ts` | Re-export `ExecutionEvent` / `ExecutionEventType` from workflow-engine if needed for type safety |

**No changes needed to**:
- `client.ts` — `publishEvent()` already exists
- `server.ts` — `POST /api/jobs/:jobId/events` endpoint already exists
- `event-bus.ts` — event buffering and SSE broadcast already works

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event delivery rate | ≥99% of events reach orchestrator under normal conditions | Count published vs emitted in integration tests |
| SC-002 | Event latency | <200ms from emission to SSE broadcast | Timestamp comparison in end-to-end test |
| SC-003 | Job failure isolation | 0 job failures caused by event forwarding errors | Inject network failures during execution; verify job succeeds |
| SC-004 | Progress accuracy | Heartbeat progress within 5% of actual completion | Compare heartbeat progress to phase/step counters |
| SC-005 | Memory stability | No listener leaks after job completion | Verify listener removal; run multiple sequential jobs |

## Assumptions

- The orchestrator's `POST /api/jobs/:jobId/events` endpoint (from #189) is deployed and operational before this feature ships
- The `EventBus` ring buffer (default capacity 1000 per job) is sufficient for typical workflow event volumes
- `ExecutionEvent.timestamp` uses Unix epoch milliseconds, matching `JobEvent.timestamp` format
- The `WorkflowExecutor.addEventListener()` API is stable and returns a disposable for cleanup
- Network latency between worker and orchestrator is typically <50ms (same cluster / local network)
- Workflows produce fewer than 1000 events per job on average (well within ring buffer capacity)

## Out of Scope

- **WebSocket transport**: Events are forwarded via REST HTTP; WebSocket upgrade is a future optimization
- **Guaranteed delivery / event persistence**: Events use fire-and-forget semantics; missed events are not retried or stored durably on the worker side
- **Client-side event consumption**: Frontend SSE subscription and UI rendering are separate concerns (#189 covers the SSE endpoint)
- **Event filtering on the worker**: All events are forwarded; filtering is done on the orchestrator/client side
- **Backpressure handling**: If the orchestrator is overwhelmed, the worker does not throttle execution — it logs and drops events
- **Multi-worker event ordering**: Events from different workers on different jobs have independent ID sequences; cross-job ordering is not guaranteed
- **Modifying `ExecutionEventEmitter` or `WorkflowExecutor`**: The workflow-engine package is not changed; we only consume its existing public API

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| High event volume overwhelms orchestrator | Events delayed or dropped | FR-006 batching; ring buffer caps on orchestrator side |
| Network partition between worker and orchestrator | Events lost during partition | Non-blocking design (FR-004); heartbeat detects connectivity issues |
| Event type mismatch between workflow-engine and orchestrator types | Runtime validation errors on POST | Explicit mapping table; integration tests covering all 15 event types |

---

*Generated by speckit*
