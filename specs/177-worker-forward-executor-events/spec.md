# Feature Specification: Worker: Forward executor events to orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17 | **Status**: Draft

## Summary

The `WorkflowExecutor` emits 15 event types (`execution:start`, `phase:start`, `step:complete`, `step:output`, `action:retry`, etc.) via its `ExecutionEventEmitter`, but these events are never consumed — the `JobHandler` only reports job status at start and result at end. This feature subscribes to executor events inside `JobHandler.executeJob()` and forwards them to the orchestrator via the existing `client.publishEvent()` REST endpoint (`POST /api/jobs/:jobId/events`), enabling real-time workflow monitoring.

Additionally, executor events will be used to compute accurate heartbeat progress based on phase/step completion rather than the current static value.

## User Stories

### US1: Real-time Workflow Monitoring

**As a** monitoring client (dashboard or API consumer),
**I want** to receive phase-level and step-level events as a workflow executes,
**So that** I can display real-time progress, detect failures early, and provide visibility into long-running workflows.

**Acceptance Criteria**:
- [ ] All phase events (`phase:start`, `phase:complete`) are forwarded to the orchestrator as they occur
- [ ] All step events (`step:start`, `step:complete`, `step:output`) are forwarded to the orchestrator
- [ ] Error events (`action:error`) are forwarded to the orchestrator
- [ ] Events are visible to SSE subscribers on `GET /api/jobs/:jobId/events`

### US2: Non-blocking Event Forwarding

**As a** workflow operator,
**I want** event forwarding failures to never interrupt job execution,
**So that** monitoring is a best-effort enhancement that doesn't compromise reliability.

**Acceptance Criteria**:
- [ ] A failed `publishEvent` call does not throw or reject in the job execution flow
- [ ] Errors during event forwarding are logged at warn level, not error
- [ ] Job execution completes successfully even if the orchestrator event endpoint is unavailable

### US3: Accurate Progress Tracking

**As a** monitoring client,
**I want** heartbeat progress to reflect actual phase/step completion percentage,
**So that** I can display meaningful progress bars instead of placeholder values.

**Acceptance Criteria**:
- [ ] Heartbeat progress is computed from completed phases/steps vs total
- [ ] Progress updates as each phase or step completes
- [ ] Progress reaches 100 only when execution completes

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Subscribe to executor events via `executor.addEventListener()` inside `JobHandler.executeJob()`, after executor creation and before `executor.execute()` | P1 | Returns `{ dispose }` — must be disposed in finally block |
| FR-002 | Map executor `ExecutionEventType` to orchestrator `JobEventType` and forward via `client.publishEvent()` | P1 | See event mapping table below |
| FR-003 | Wrap every `publishEvent` call in try/catch — log warnings on failure, never propagate errors | P1 | Non-blocking is a hard requirement |
| FR-004 | Map unmapped executor events (`phase:error`, `step:error`, `action:start`, `action:complete`, `action:retry`) to `log:append` | P2 | Preserves all event data without requiring schema changes |
| FR-005 | Skip forwarding `execution:*` events — these are redundant with existing `updateJobStatus` and `reportJobResult` calls | P2 | Avoids duplicate status reporting |
| FR-006 | Include timing data in forwarded events: use `event.timestamp` from executor, add `duration` for completion events extracted from `event.data` | P2 | Enables latency monitoring on the dashboard |
| FR-007 | Compute heartbeat progress from executor events: track completed phases vs total phases in the workflow | P2 | Requires knowing total phase count from workflow definition |
| FR-008 | Buffer rapid-fire events (especially `step:output`) for up to 100ms before sending as a batch | P3 | Optional optimization — can be deferred to a follow-up |
| FR-009 | Flush buffer immediately for high-priority events: `phase:start`, `phase:complete`, `step:complete`, `action:error` | P3 | Only relevant if FR-008 is implemented |
| FR-010 | Dispose event listener in the `finally` block of `executeJob()` to prevent memory leaks | P1 | Critical for long-running worker processes |

## Event Mapping

| Executor `ExecutionEventType` | Orchestrator `JobEventType` | Forward? | Notes |
|---|---|---|---|
| `execution:start` | — | No | Redundant with `updateJobStatus('running')` |
| `execution:complete` | — | No | Redundant with `reportJobResult()` |
| `execution:error` | — | No | Redundant with `reportJobResult()` |
| `execution:cancel` | — | No | Redundant with `updateJobStatus('cancelled')` |
| `phase:start` | `phase:start` | Yes | Direct mapping. Data: `{ phaseName }` |
| `phase:complete` | `phase:complete` | Yes | Direct mapping. Data: `{ phaseName, duration }` |
| `phase:error` | `log:append` | Yes | No direct match. Data: `{ level: 'error', phaseName, message }` |
| `step:start` | `step:start` | Yes | Direct mapping. Data: `{ phaseName, stepName }` |
| `step:complete` | `step:complete` | Yes | Direct mapping. Data: `{ phaseName, stepName, duration }` |
| `step:error` | `log:append` | Yes | No direct match. Data: `{ level: 'error', phaseName, stepName, message }` |
| `step:output` | `step:output` | Yes | Direct mapping. Data: `{ phaseName, stepName, message }` |
| `action:start` | `log:append` | Yes | No direct match. Data: `{ level: 'info', phaseName, stepName, message }` |
| `action:complete` | `log:append` | Yes | No direct match. Data: `{ level: 'info', phaseName, stepName, duration }` |
| `action:error` | `action:error` | Yes | Direct mapping. Data: `{ phaseName, stepName, message }` |
| `action:retry` | `log:append` | Yes | No direct match. Data: `{ level: 'warn', phaseName, stepName, message, retryState }` |

## Files to Modify

| File | Change |
|---|---|
| `packages/generacy/src/orchestrator/job-handler.ts` | Subscribe to executor events, map and forward via `publishEvent`, compute progress, dispose listener |
| `packages/generacy/src/orchestrator/types.ts` | Import and re-export `ExecutionEventType` and `ExecutionEvent` from `workflow-engine` for type-safe mapping |

**Note**: No changes needed to `client.ts` — the `publishEvent()` method already exists with the correct signature and endpoint.

## Implementation Sketch

```typescript
// Inside JobHandler.executeJob(), after executor creation:

const totalPhases = workflow.phases.length;
let completedPhases = 0;

const subscription = executor.addEventListener(async (event: ExecutionEvent) => {
  // Skip execution-level events (handled by updateJobStatus/reportJobResult)
  if (event.type.startsWith('execution:')) return;

  // Map executor event type to orchestrator event type
  const mappedType = mapEventType(event.type);

  // Build event data payload
  const data: Record<string, unknown> = {
    phaseName: event.phaseName,
    stepName: event.stepName,
    message: event.message,
    ...typeof event.data === 'object' ? event.data as Record<string, unknown> : {},
  };

  // Update progress on phase completion
  if (event.type === 'phase:complete') {
    completedPhases++;
    this.heartbeatManager?.setProgress(
      Math.round((completedPhases / totalPhases) * 100)
    );
  }

  // Forward — non-blocking
  try {
    await this.client.publishEvent(job.id, {
      type: mappedType,
      data,
      timestamp: event.timestamp,
    });
  } catch (err) {
    this.logger.warn('Failed to forward executor event', {
      eventType: event.type,
      jobId: job.id,
      error: err,
    });
  }
});

// ... executor.execute() ...

// In finally block:
subscription.dispose();
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event coverage | 100% of phase/step/action events forwarded | Unit test: mock executor emits all event types, verify `publishEvent` called for each non-execution event |
| SC-002 | Non-blocking guarantee | 0 job failures caused by event forwarding | Unit test: `publishEvent` rejects, verify `executor.execute()` still resolves successfully |
| SC-003 | Progress accuracy | Heartbeat progress matches `completedPhases / totalPhases * 100` | Unit test: emit N `phase:complete` events, verify heartbeat progress after each |
| SC-004 | Event latency | < 200ms from executor emit to orchestrator receipt | Integration test: timestamp comparison in test environment |
| SC-005 | No memory leaks | Event listener disposed after every job | Unit test: verify `subscription.dispose()` called in finally block |

## Assumptions

- The orchestrator's `POST /api/jobs/:jobId/events` endpoint (from #176) is implemented and accepts events with the `JobEventType` union
- The orchestrator validates incoming event types against the `JobEventType` union — events with unknown types will be rejected
- `executor.addEventListener()` is synchronous and returns immediately with a `{ dispose }` handle
- The executor emits events on the same tick or microtask as the workflow step that triggers them (no cross-process boundary)
- The worker has network access to the orchestrator throughout the job's lifetime (same assumption as existing `updateJobStatus` / `reportJobResult` calls)
- The `workflow.phases` array is available before execution starts, giving us the total phase count for progress calculation

## Out of Scope

- **Orchestrator-side event storage or persistence** — handled by #176
- **SSE streaming to monitoring clients** — handled by existing SSE infrastructure in the orchestrator
- **Adding new event types to the orchestrator's `JobEventType` union** — unmapped events are forwarded as `log:append` to avoid schema changes
- **Event batching optimization** (FR-008/FR-009) — documented as P3, can be implemented in a follow-up if `step:output` volume becomes a problem
- **Retry logic for failed event forwarding** — events are fire-and-forget; if one fails, it's dropped
- **WebSocket-based event transport** — REST is the chosen transport for this iteration
- **Worker-side event persistence or queuing** — no local buffering beyond the optional 100ms batch window

---

*Generated by speckit*
