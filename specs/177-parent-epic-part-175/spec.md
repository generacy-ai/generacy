# Feature Specification: Forward Executor Events to Orchestrator via REST

**Branch**: `177-parent-epic-part-175` | **Date**: 2026-02-23 | **Status**: Draft
**Parent Epic**: #175 — Real-time workflow monitoring

## Summary

The `WorkflowExecutor` emits 15 event types (`execution:start`, `phase:start`, `step:complete`, `step:output`, `action:retry`, etc.) via `ExecutionEventEmitter`, but these events stay local to the worker process. The orchestrator already accepts 8 event types via `POST /api/jobs/:jobId/events` and has full SSE infrastructure (`EventBus`, `RingBuffer`) for streaming them to monitoring clients.

This feature bridges the gap: expand the existing event listener in `job-handler.ts` to forward executor events to the orchestrator using the existing `OrchestratorClient.publishEvent()` method, map the 15 executor event types to the 8 orchestrator event types, and use event data to compute accurate heartbeat progress.

### Current State

In `job-handler.ts` (line 330), the `WorkflowExecutor`'s event listener only handles two event types:
- `step:error` — tracks phase failures for GitHub label logic
- `phase:complete` — adds GitHub labels on phase completion

All other events are silently discarded. The worker only reports:
- Job status transitions (`updateJobStatus`)
- Final result (`reportJobResult`)
- Heartbeat with static progress (no phase/step granularity)

### Target State

All executor events are mapped and forwarded to the orchestrator in real-time via the existing REST endpoint, with optional batching for high-frequency events and accurate progress tracking based on phase/step completion.

## User Stories

### US1: Real-time Phase/Step Visibility

**As a** monitoring client (developer or UI dashboard),
**I want** to receive live phase and step events as a workflow executes,
**So that** I can display real-time progress and status for each phase and step of a running workflow.

**Acceptance Criteria**:
- [ ] `phase:start` and `phase:complete` executor events are forwarded as `phase:start` and `phase:complete` job events
- [ ] `step:start`, `step:complete`, and `step:output` executor events are forwarded as `step:start`, `step:complete`, and `step:output` job events
- [ ] Events arrive at the orchestrator's `EventBus` within 200ms of emission (accounting for optional batching)
- [ ] Forwarded events include `phaseName`, `stepName`, `timestamp`, and any `data` payload from the original event

### US2: Non-blocking Event Forwarding

**As a** workflow operator,
**I want** event forwarding failures to be silently handled,
**So that** a network glitch or orchestrator outage does not interrupt or fail my running workflow.

**Acceptance Criteria**:
- [ ] Failures in `publishEvent()` are caught and logged but do not throw into the executor
- [ ] The existing `step:error` / `phase:complete` label logic in the event listener continues to work unchanged
- [ ] Job execution completes successfully even if 100% of event publish calls fail

### US3: Accurate Progress in Heartbeat

**As a** monitoring dashboard,
**I want** the worker heartbeat to reflect actual workflow progress based on completed phases and steps,
**So that** I can display a meaningful progress percentage rather than a static or estimated value.

**Acceptance Criteria**:
- [ ] Progress is calculated as a percentage of completed phases/steps vs total
- [ ] Heartbeat progress updates after each `phase:complete` or `step:complete` event
- [ ] Progress starts at 0 when the job begins and reaches 100 when execution completes

### US4: Error and Retry Visibility

**As a** developer debugging a failed workflow,
**I want** to see action-level errors and retries in the event stream,
**So that** I can diagnose which specific actions failed and how many retries occurred.

**Acceptance Criteria**:
- [ ] `action:error` and `action:retry` executor events are forwarded as `action:error` job events
- [ ] Error events include the error message and stack trace (if available) in the event data
- [ ] Retry events include the retry count and reason in the event data

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Expand the existing event listener in `job-handler.ts` (line 330) to handle all 15 executor event types | P1 | Preserve existing `step:error` / `phase:complete` label logic |
| FR-002 | Map executor `ExecutionEventType` to orchestrator `JobEventType` (see mapping table below) | P1 | 15 source types → 8 target types; 2 action types dropped as noise |
| FR-003 | Call `client.publishEvent(jobId, { type, data, timestamp })` for each mapped event | P1 | Uses existing method at `client.ts:185` |
| FR-004 | Wrap each `publishEvent()` call in try-catch; log errors at warn level, do not rethrow | P1 | Non-blocking is critical |
| FR-005 | Track completed phases/steps and compute progress percentage from workflow definition | P2 | Requires knowing total phase/step count |
| FR-006 | Update `HeartbeatManager.setCurrentJob()` progress after each phase/step completion | P2 | Uses existing heartbeat infrastructure at `heartbeat.ts` |
| FR-007 | Buffer high-frequency events (`step:output`) for up to 100ms before sending a batch | P3 | Flush immediately for critical events |
| FR-008 | Flush any buffered events before `client.reportJobResult()` to maintain event ordering | P3 | Prevents events arriving after the final result |
| FR-009 | Re-export `ExecutionEventType` from `types.ts` for type safety in job-handler | P1 | Import from `@generacy-ai/workflow-engine` |

### Event Type Mapping

| WorkflowExecutor Event | Orchestrator JobEventType | Forward? | Notes |
|---|---|---|---|
| `execution:start` | `job:status` | Yes | `data: { status: 'running' }` |
| `execution:complete` | `job:status` | Yes | `data: { status: 'completed' }` |
| `execution:error` | `job:status` | Yes | `data: { status: 'failed', error }` |
| `execution:cancel` | `job:status` | Yes | `data: { status: 'cancelled' }` |
| `phase:start` | `phase:start` | Yes | Direct mapping |
| `phase:complete` | `phase:complete` | Yes | Direct mapping, include duration |
| `phase:error` | `action:error` | Yes | Map to `action:error` with phase context |
| `step:start` | `step:start` | Yes | Direct mapping |
| `step:complete` | `step:complete` | Yes | Direct mapping, include duration |
| `step:error` | `action:error` | Yes | Map to `action:error` with step context |
| `step:output` | `step:output` | Yes | Direct mapping, may be high-frequency |
| `action:start` | — | No | Too granular; action-level start adds noise |
| `action:complete` | — | No | Too granular; action-level complete adds noise |
| `action:error` | `action:error` | Yes | Direct mapping |
| `action:retry` | `action:error` | Yes | Map with `{ retrying: true, retryCount }` |

### Progress Calculation

Progress is computed from phase/step completion:

```
phaseProgress = completedStepsInCurrentPhase / totalStepsInCurrentPhase
overallProgress = ((completedPhases + phaseProgress) / totalPhases) * 100
```

The total phase and step counts are derived from the workflow definition passed to `executor.execute()`.

## Files to Modify

| File | Change | Scope |
|------|--------|-------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Register a second event listener to map and forward all events; add progress tracking | Primary |
| `packages/generacy/src/orchestrator/types.ts` | Import/re-export `ExecutionEventType` from `@generacy-ai/workflow-engine` | Supporting |

No new files are required. The `OrchestratorClient.publishEvent()` method already exists at `client.ts:185` and the `POST /api/jobs/:jobId/events` endpoint is already implemented in `server.ts:499`.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event forwarding coverage | 13 of 15 event types forwarded (2 dropped as noise) | Unit test verifying all mapped event types reach `publishEvent()` |
| SC-002 | Event delivery latency | < 200ms from emission to orchestrator receipt | Timestamp comparison in integration test |
| SC-003 | Non-blocking guarantee | 0 job failures caused by event forwarding errors | Fault injection test: mock `publishEvent()` to throw, verify job completes |
| SC-004 | Progress accuracy | Heartbeat progress within 5% of actual completion | Compare heartbeat progress to phase/step completion ratio |
| SC-005 | No regression | Existing GitHub label logic unaffected | Existing tests for `phase:complete` label addition pass unchanged |

## Assumptions

- The orchestrator's `POST /api/jobs/:jobId/events` endpoint (from #176) is implemented and accepts the 8 `JobEventType` values
- The `EventBus` and `RingBuffer` infrastructure on the orchestrator side handles buffering and SSE distribution — no server-side changes needed
- The `WorkflowExecutor` event emitter emits events synchronously during execution (as implemented in `executor/events.ts`)
- The workflow definition passed to `executor.execute()` contains phase and step counts needed for progress calculation
- `OrchestratorClient.publishEvent()` handles network retries internally (consistent with other client methods using exponential backoff)
- The `ExecutionEventEmitter` supports multiple listeners via its internal `Set<ExecutionEventListener>`, so a second listener can be registered without affecting the existing one

## Out of Scope

- **Server-side event endpoint changes** — `POST /api/jobs/:jobId/events` and `EventBus`/`RingBuffer` infrastructure are already implemented (#176)
- **SSE streaming to clients** — Already handled by existing orchestrator SSE endpoints (`GET /api/jobs/:jobId/events`, `GET /api/events`)
- **Event persistence to database** — Events are buffered in memory via `RingBuffer`; persistent storage is a separate concern
- **New orchestrator event types** — We map to the existing 8 `JobEventType` values; adding new types (e.g., first-class `action:retry`) is future work
- **UI changes for real-time monitoring** — This feature only handles the worker → orchestrator leg; UI consumption is a separate feature
- **WebSocket transport** — REST + SSE is the current architecture; migration to WebSockets is out of scope
- **Event replay/recovery** — If events are lost due to network failures, they are not retried; the `RingBuffer` handles reconnection on the SSE consumer side

## Technical Notes

### Preserving Existing Logic

The current event listener at `job-handler.ts:330` handles `step:error` tracking and `phase:complete` label addition. The implementation should register a **second** listener via `executor.addEventListener()` — the `ExecutionEventEmitter` supports multiple listeners via a `Set` — to keep forwarding logic separate from label logic.

### Batching Strategy (P3)

If implemented, the batching buffer should:
- Use a 100ms flush timer that resets on each new event
- Maintain a maximum buffer size (e.g., 50 events) to prevent unbounded memory growth
- Flush immediately for critical events: `phase:start`, `phase:complete`, `step:complete`, `execution:*`, `*:error`
- Be flushed before `client.reportJobResult()` to maintain event ordering
- Call `publishEvent()` sequentially for each buffered event (the current API accepts single events)

### Error Handling

Event forwarding errors should be:
- Caught at the individual event level (not the listener level)
- Logged at `warn` level with the event type and job ID
- Never propagated to the executor or job handler

---

*Generated by speckit*
