# Feature Specification: Worker — Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17 | **Status**: Draft

## Summary

The `WorkflowExecutor` emits 14 event types (`execution:start`, `phase:start`, `step:output`, `action:retry`, etc.) via `ExecutionEventEmitter`, but these events are silently discarded in the worker process. This feature subscribes to those events in `JobHandler`, maps them to `JobEventType`, and forwards them to the orchestrator via the existing `OrchestratorClient.publishEvent()` REST endpoint. It also introduces event batching to avoid overwhelming the orchestrator and derives accurate heartbeat progress from phase/step completion data.

## User Stories

### US1: Real-Time Workflow Visibility

**As a** monitoring client (dashboard or CLI user),
**I want** to receive live phase, step, and action events as a workflow executes,
**So that** I can display real-time progress and diagnose issues without waiting for the job to finish.

**Acceptance Criteria**:
- [ ] All 14 executor event types are captured in `JobHandler` via `executor.addEventListener()`
- [ ] Events are forwarded to the orchestrator via `POST /api/jobs/:jobId/events`
- [ ] SSE subscribers on `GET /api/jobs/:jobId/events` receive each forwarded event within 200ms of it being emitted (excluding network latency)
- [ ] `step:output` events carry the step's stdout/stderr content in `data`

### US2: Non-Blocking Event Delivery

**As a** worker process,
**I want** event forwarding failures to be silently logged and not propagate,
**So that** a temporary orchestrator outage or network hiccup does not abort a running workflow.

**Acceptance Criteria**:
- [ ] If `publishEvent()` throws, the error is caught and logged at `warn` level
- [ ] The workflow execution continues uninterrupted regardless of event delivery failures
- [ ] Consecutive failures are tracked; after 10 consecutive failures, forwarding is temporarily paused (circuit-breaker) for 30 seconds before retrying
- [ ] When forwarding resumes after a pause, any events that occurred during the pause are lost (not queued indefinitely)

### US3: Accurate Heartbeat Progress

**As a** monitoring client,
**I want** the worker heartbeat to report a progress percentage derived from actual workflow completion,
**So that** progress bars and ETAs reflect reality instead of showing a static 0→100 jump.

**Acceptance Criteria**:
- [ ] Progress is calculated as `(completedPhases / totalPhases) * 100`, refined by step-level progress within the current phase
- [ ] The `HeartbeatManager.progress` field is updated each time a `phase:complete` or `step:complete` event fires
- [ ] Progress never decreases (monotonically increasing)
- [ ] Progress reaches exactly 100 only when `execution:complete` fires

### US4: Event Batching Under Load

**As an** orchestrator,
**I want** the worker to batch rapid-fire events (e.g., many `step:output` events),
**So that** I am not overwhelmed with individual HTTP requests during high-throughput phases.

**Acceptance Criteria**:
- [ ] Events are buffered for up to 100ms before being sent as a batch
- [ ] Critical events (`phase:start`, `phase:complete`, `phase:error`, `step:complete`, `step:error`, `execution:complete`, `execution:error`, `execution:cancel`) flush the buffer immediately
- [ ] Batches are sent via a single HTTP call (array of events to `POST /api/jobs/:jobId/events`)
- [ ] When the executor finishes (complete, error, or cancel), any remaining buffered events are flushed before `reportJobResult()` is called

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Subscribe to all executor events via `executor.addEventListener()` in `JobHandler.executeJob()` | P1 | Dispose listener after execution completes |
| FR-002 | Map `ExecutionEvent` to `JobEvent` shape: translate `ExecutionEventType` → `JobEventType`, copy `timestamp`, populate `data` from event fields | P1 | See mapping table below |
| FR-003 | Forward mapped events to orchestrator via `OrchestratorClient.publishEvent()` | P1 | Non-blocking; errors caught and logged |
| FR-004 | Implement `EventBatcher` class that buffers events for up to 100ms, flushes immediately for critical event types | P1 | Configurable flush interval |
| FR-005 | Add batch endpoint support: `OrchestratorClient.publishEvents()` accepts an array and posts to `POST /api/jobs/:jobId/events` | P2 | Falls back to individual calls if batch endpoint unavailable |
| FR-006 | Calculate progress from phase/step completion and update `HeartbeatManager.progress` | P1 | Requires workflow metadata (total phases/steps) |
| FR-007 | Implement circuit-breaker: after N consecutive publish failures, pause forwarding for a configurable backoff period | P2 | Default: 10 failures → 30s pause |
| FR-008 | Dispose event listener and flush remaining events before reporting job result | P1 | Prevents event loss at job completion |
| FR-009 | Add timing data (`duration`) to `phase:complete` and `step:complete` events by tracking start timestamps | P2 | Duration = complete.timestamp - start.timestamp |
| FR-010 | Extend `JobEventType` to cover all executor event types that don't currently have a mapping | P1 | See mapping table below |

### Event Type Mapping

The executor emits 14 `ExecutionEventType` values. The orchestrator currently defines 8 `JobEventType` values. The following mapping bridges them:

| ExecutionEventType | → JobEventType | Action |
|--------------------|----------------|--------|
| `execution:start` | `job:status` | Map to status event with `data: { status: 'running' }` |
| `execution:complete` | `job:status` | Map to status event with `data: { status: 'completed' }` |
| `execution:error` | `job:status` | Map to status event with `data: { status: 'failed', error }` |
| `execution:cancel` | `job:status` | Map to status event with `data: { status: 'cancelled' }` |
| `phase:start` | `phase:start` | Direct mapping; include `phaseName` in `data` |
| `phase:complete` | `phase:complete` | Direct mapping; include `phaseName`, `duration` in `data` |
| `phase:error` | `action:error` | Map to error event with `data: { phaseName, error }` |
| `step:start` | `step:start` | Direct mapping; include `phaseName`, `stepName` in `data` |
| `step:complete` | `step:complete` | Direct mapping; include `phaseName`, `stepName`, `duration` in `data` |
| `step:error` | `action:error` | Map to error event with `data: { phaseName, stepName, error }` |
| `step:output` | `step:output` | Direct mapping; include `phaseName`, `stepName`, output in `data` |
| `action:start` | `log:append` | Map to log with `data: { phaseName, stepName, message }` |
| `action:complete` | `log:append` | Map to log with `data: { phaseName, stepName, message }` |
| `action:error` | `action:error` | Direct mapping |
| `action:retry` | `log:append` | Map to log with `data: { phaseName, stepName, attempt, maxAttempts }` |

### Progress Calculation Formula

```
overallProgress = (completedPhaseWeight + currentPhasePartialWeight) / totalPhaseWeight * 100

where:
  completedPhaseWeight = number of fully completed phases
  currentPhasePartialWeight = completedStepsInCurrentPhase / totalStepsInCurrentPhase
  totalPhaseWeight = total number of phases in workflow
```

If step counts are unavailable, fall back to phase-only granularity: `completedPhases / totalPhases * 100`.

## Technical Design

### Files to Modify

| File | Change |
|------|--------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Subscribe to executor events after creation; wire up `EventForwarder`; dispose on completion |
| `packages/generacy/src/orchestrator/client.ts` | Add `publishEvents()` batch method (array variant of `publishEvent()`) |
| `packages/generacy/src/orchestrator/types.ts` | Re-export `ExecutionEventType` from workflow-engine; add missing `JobEventType` values if needed |

### New Files

| File | Purpose |
|------|---------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | `EventForwarder` class encapsulating batching, mapping, circuit-breaker, and progress tracking |

### EventForwarder Class (Sketch)

```typescript
class EventForwarder {
  constructor(options: {
    client: OrchestratorClient;
    jobId: string;
    heartbeatManager: HeartbeatManager;
    logger: Logger;
    totalPhases: number;
    stepsPerPhase: Map<string, number>;
    flushIntervalMs?: number;        // default 100
    circuitBreakerThreshold?: number; // default 10
    circuitBreakerResetMs?: number;   // default 30_000
  });

  /** Called by executor event listener */
  handleEvent(event: ExecutionEvent): void;

  /** Flush remaining events — must be awaited before reportJobResult */
  flush(): Promise<void>;

  /** Clean up timers and state */
  dispose(): void;
}
```

### Integration Point in JobHandler

```typescript
// In executeJob(), after creating executor:
const forwarder = new EventForwarder({
  client: this.client,
  jobId: job.id,
  heartbeatManager: this.heartbeatManager,
  logger: this.logger,
  totalPhases: workflow.phases.length,
  stepsPerPhase: new Map(workflow.phases.map(p => [p.name, p.steps.length])),
});

const subscription = executor.addEventListener((event) => {
  forwarder.handleEvent(event);
});

try {
  const result = await executor.execute(workflow, options, job.inputs);
  await forwarder.flush();
  // ... reportJobResult
} finally {
  subscription.dispose();
  forwarder.dispose();
}
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event delivery latency (emit → SSE subscriber) | < 300ms p95 | Instrument timestamps at emit and receive |
| SC-002 | Event delivery reliability | > 99% of events delivered under normal conditions | Count events emitted vs. received in integration test |
| SC-003 | Heartbeat progress accuracy | Progress reaches 100 iff workflow completes | Verify in test that progress is monotonic and terminal |
| SC-004 | Zero impact on job execution from forwarding failures | 0 job failures caused by event forwarding | Simulate orchestrator downtime during workflow execution |
| SC-005 | Batch efficiency | >= 50% reduction in HTTP calls for high-throughput phases vs. unbatched | Compare request counts with and without batching in load test |

## Assumptions

- The orchestrator's `POST /api/jobs/:jobId/events` endpoint (server.ts:499-556) already accepts and stores events — no server-side changes needed for single-event publishing
- `ExecutionEventEmitter` fires events synchronously on the executor's thread; the listener callback must not block
- Workflow metadata (total phases, steps per phase) is available from the `Workflow` object passed to `executor.execute()` for progress calculation
- The `HeartbeatManager` instance is accessible from `JobHandler` (it is already instantiated in the worker bootstrap)
- Network latency between worker and orchestrator is typically < 50ms (same network / localhost in dev)

## Out of Scope

- **Server-side event endpoint changes**: The orchestrator's REST and SSE endpoints are assumed to be ready (covered by #176)
- **Event persistence / replay on the worker side**: Events lost during circuit-breaker pauses are not recovered; this is acceptable for monitoring data
- **WebSocket transport**: This feature uses REST; a future WebSocket upgrade is a separate effort
- **Event schema versioning**: No versioning envelope is added; can be introduced later if needed
- **UI/dashboard changes**: Consuming and rendering events in a frontend is handled by separate issues
- **Authentication/authorization for event endpoints**: Assumed to use the same worker auth token already in place for heartbeat and job polling
- **Backpressure from orchestrator to worker**: If the orchestrator is slow, the worker does not slow down execution; it drops events via the circuit-breaker instead

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| High event volume from `step:output` overwhelms orchestrator | Orchestrator event bus fills up; SSE subscribers lag | Batching (FR-004) + orchestrator-side ring buffer already caps storage |
| Network partition causes all events to be lost | Monitoring gap during outage | Circuit-breaker logs warnings; events are monitoring-only, not critical data |
| Progress calculation is inaccurate if workflow phases are dynamically added | Progress jumps or exceeds 100% | Clamp progress to [0, 100]; re-derive total from workflow object at each phase boundary |
| Blocking the executor's event listener thread | Slows down workflow execution | All I/O (HTTP calls) is fire-and-forget via `Promise` — the listener callback returns immediately |

---

*Generated by speckit*
