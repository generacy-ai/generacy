# Implementation Plan: Worker — Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17

## Summary

Create an `EventForwarder` class that subscribes to `WorkflowExecutor` events, maps them to `JobEventType`, and forwards them to the orchestrator via `OrchestratorClient.publishEvent()`. The forwarder is non-blocking (errors are swallowed), supports batching for high-frequency events, and updates heartbeat progress on phase completion. Integration requires minimal changes to `JobHandler` and `worker.ts`.

## Technical Context

- **Language**: TypeScript (ESM, `.js` extensions in imports)
- **Runtime**: Node.js
- **Packages involved**:
  - `packages/generacy/src/orchestrator/` — worker-side job handling and orchestrator communication
  - `packages/workflow-engine/` — executor, events, workflow types (read-only dependency)
- **Key dependencies (already implemented, no changes needed)**:
  - `OrchestratorClient.publishEvent()` — POST to `/api/jobs/:jobId/events`
  - `WorkflowExecutor.addEventListener()` — returns `{ dispose() }` disposable
  - `HeartbeatManager.setCurrentJob(jobId, progress)` — accepts optional progress
  - Server-side `POST /api/jobs/:jobId/events` endpoint with EventBus broadcast

## Architecture Overview

```
┌──────────────┐    sync callback    ┌──────────────────┐   async POST    ┌──────────────────┐
│  Workflow     │──────────────────>  │  EventForwarder   │──────────────>  │  Orchestrator     │
│  Executor     │   ExecutionEvent    │  (per-job)        │   publishEvent  │  Server           │
│  (engine)     │                     │  - map event      │                 │  - EventBus       │
└──────────────┘                     │  - batch/flush    │                 │  - SSE broadcast  │
                                     │  - track progress │                 └──────────────────┘
                                     └────────┬─────────┘
                                              │ onProgress callback
                                     ┌────────▼─────────┐
                                     │  HeartbeatManager  │
                                     │  (via worker.ts)   │
                                     └──────────────────┘
```

**Lifecycle**: Per-job `EventForwarder` instance created in `JobHandler.executeJob()` after loading the workflow. Connected before `executor.execute()`, disposed in `finally` block.

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| Q1 | Skip `execution:*` events (don't forward as `job:status`) | Existing `updateJobStatus` and `reportJobResult` already publish `job:status` events. Forwarding would cause duplicates and double SSE cleanup. |
| Q2 | Use `onProgress` callback on `JobHandlerOptions` | Follows existing callback pattern (`onJobStart`, `onJobComplete`). Keeps `JobHandler` decoupled from `HeartbeatManager`. |
| Q3 | Pass `totalPhases` to EventForwarder from workflow definition | `execution:start` event doesn't include phase count. `workflow.phases.length` is available after `prepareWorkflow()`. |
| Q4 | Sequential sends within a batch flush | Preserves event ordering for monitoring clients. Non-blocking fire-and-forget, so no executor impact. |
| Q5 | Structured error extraction (`message`, truncated to 4KB) | Safe serialization, no circular references. Enough context for debugging. |
| Q6 | Per-job EventForwarder instance | Simple, no state leakage. Created/disposed per `executeJob()` call, same as executor. |
| Q7 | Phase-level progress only | Simpler implementation. Progress = `(completedPhases / totalPhases) * 100`. Step-level can be added later. |
| Q8 | Hard buffer cap (100) with oldest-drop | Prevents unbounded memory growth. Priority events bypass buffer. Warn on drop. |
| Q9 | Simple `log:append` format: `{ message, level?, source? }` | Consistent, easy for UIs to render. No prior convention exists. |

See [research.md](./research.md) for detailed rationale on each decision.
See [data-model.md](./data-model.md) for type definitions and event mapping tables.

## Implementation Phases

### Phase 1: EventForwarder Core (P1 — event mapping and forwarding)

**New file**: `packages/generacy/src/orchestrator/event-forwarder.ts`

Create the `EventForwarder` class with:

1. **Constructor** accepting `EventForwarderOptions` (client, jobId, totalPhases, logger, onProgress callback)
2. **`connect(executor)`** method:
   - Calls `executor.addEventListener(listener)` and stores the dispose handle
   - Listener calls `this.handleEvent(event)` synchronously
3. **`handleEvent(event)`** method:
   - Switch on `event.type` to map `ExecutionEventType` → `JobEventType` + data payload
   - Skip `execution:*` events entirely (handled by existing status flow)
   - For immediate-priority events: call `this.flushBuffer()` then `this.sendEvent()`
   - For deferred events: push to `pendingEvents` buffer, schedule flush timer
4. **Event mapping** per the mapping table in [data-model.md](./data-model.md):
   - `phase:start` → `phase:start` with `{ phaseName, workflowName }`
   - `phase:complete` → `phase:complete` with `{ phaseName, workflowName, duration? }`; increment `completedPhases`; call `onProgress`
   - `phase:error` → `phase:complete` with `{ phaseName, workflowName, error, status: 'failed' }`; increment `completedPhases`; call `onProgress`
   - `step:start` → `step:start` with `{ stepName, phaseName, workflowName }`
   - `step:complete` → `step:complete` with `{ stepName, phaseName, workflowName, duration? }`
   - `step:error` → `step:complete` with `{ stepName, phaseName, error, status: 'failed' }`
   - `step:output` → `step:output` with `{ stepName, phaseName, message?, data? }` (deferred)
   - `action:start` → `log:append` with `{ message: '...', level: 'info', source: 'action:start' }` (deferred)
   - `action:complete` → `log:append` with `{ message: '...', level: 'info', source: 'action:complete' }` (deferred)
   - `action:error` → `action:error` with `{ stepName, phaseName, error, data? }`
   - `action:retry` → `log:append` with `{ message: '...', level: 'warn', source: 'action:retry' }` (deferred)
5. **`sendEvent(mapped)`** — fire-and-forget `client.publishEvent()`:
   ```typescript
   private sendEvent(event: { type: JobEventType; data: Record<string, unknown>; timestamp: number }): void {
     this.client.publishEvent(this.jobId, event).catch((error) => {
       this.logger.warn(`Failed to forward event: ${error.message}`);
     });
   }
   ```
6. **Error extraction helper**: Extract error message from `event.data` or `event.message`, truncate to 4096 chars
7. **Duration extraction**: For `phase:complete`/`step:complete`, extract duration from `event.data` if available (executor sets `duration` on result objects)
8. **`dispose()`** method:
   - Call `subscription.dispose()` to remove the event listener
   - Flush any remaining buffered events
   - Clear the flush timer

**Files**:
| File | Action | Lines |
|------|--------|-------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | Create | ~150 |

**Depends on**: Nothing (standalone class)

### Phase 2: Batching (P2 — reduce HTTP overhead)

Add batching logic to `EventForwarder`:

1. **Buffer management**:
   - `pendingEvents: Array<MappedEvent>` — bounded at `maxBufferSize` (default 100)
   - On push: if buffer full, drop oldest deferred event, log warning
2. **Priority classification**:
   - **Immediate**: `phase:start`, `phase:complete`, `step:start`, `step:complete`, `action:error`, `phase:error`, `step:error`
   - **Deferred**: `step:output`, `action:start`, `action:complete`, `action:retry` (mapped to `log:append`)
3. **Flush logic**:
   - Immediate events: flush entire buffer first (preserving order), then send the immediate event
   - Deferred events: push to buffer, schedule flush after `batchIntervalMs` (default 100ms) if not already scheduled
   - Buffer size threshold: if buffer reaches 20 events, flush immediately
4. **`flushBuffer()`** method:
   - Clear flush timer
   - Send buffered events sequentially via `sendEvent()` (preserves ordering)
   - Each `sendEvent` is still fire-and-forget (non-blocking)
   - Implementation: iterate `pendingEvents`, fire each `sendEvent()`, clear array
5. **Flush on dispose**: `dispose()` calls `flushBuffer()` before cleanup

**Files**:
| File | Action | Lines |
|------|--------|-------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | Modify | +50 |

**Depends on**: Phase 1

### Phase 3: JobHandler Integration (P1 — wire up EventForwarder)

Modify `JobHandler.executeJob()` to create and use EventForwarder:

1. **Add `onProgress` to `JobHandlerOptions`**:
   ```typescript
   /** Callback for progress updates during job execution */
   onProgress?: (jobId: string, progress: number) => void;
   ```
2. **Store `onProgress` in constructor** alongside existing callbacks
3. **In `executeJob()`, after `prepareWorkflow()` (line 226) and before `executor.execute()` (line 234)**:
   ```typescript
   // Create event forwarder
   const forwarder = new EventForwarder({
     client: this.client,
     jobId: job.id,
     totalPhases: workflow.phases.length,
     logger: this.logger,
     onProgress: this.onProgress,
   });
   forwarder.connect(executor);
   ```
4. **In the `finally` block (line 274), before clearing `currentJob`**:
   ```typescript
   forwarder.dispose();
   ```
5. **Move `forwarder` declaration** to `executeJob` scope (before try block) so it's accessible in `finally`:
   - Declare `let forwarder: EventForwarder | undefined;` at the top of `executeJob()`
   - Create and connect inside `try` after workflow loading
   - Dispose in `finally` with optional chaining: `forwarder?.dispose()`

**Files**:
| File | Action | Key changes |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Modify | Add `onProgress` to options, create/connect/dispose EventForwarder in `executeJob()` |

**Depends on**: Phase 1

### Phase 4: Worker Command Wiring (P2 — heartbeat progress)

Wire up the `onProgress` callback in `worker.ts`:

1. **Add `onProgress` to `JobHandler` construction** (worker.ts, around line 146):
   ```typescript
   onProgress: (jobId, progress) => {
     heartbeatManager.setCurrentJob(jobId, progress);
   },
   ```

**Files**:
| File | Action | Key changes |
|------|--------|-------------|
| `packages/generacy/src/cli/commands/worker.ts` | Modify | Add `onProgress` callback wiring |

**Depends on**: Phase 3

### Phase 5: Module Exports (P1 — public API)

1. **Export `EventForwarder` from orchestrator index**:
   ```typescript
   export { EventForwarder } from './event-forwarder.js';
   export type { EventForwarderOptions } from './event-forwarder.js';
   ```

**Files**:
| File | Action | Key changes |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/index.ts` | Modify | Add EventForwarder export |

**Depends on**: Phase 1

### Phase 6: Unit Tests

Write tests for:

1. **Event mapping coverage** (SC-001): Emit each of the 11 forwarded event types, verify `publishEvent` called with correct `JobEventType` and data payload
2. **Skipped events**: Emit `execution:start/complete/error/cancel`, verify `publishEvent` NOT called
3. **Non-blocking guarantee** (SC-002): Stub `publishEvent` to reject, verify no exception propagates to caller
4. **Error logging**: Verify failed `publishEvent` calls log at `warn` level
5. **Progress tracking** (SC-003): Emit `phase:complete` events, verify `onProgress` called with correct percentage
6. **Batch efficiency** (SC-004): Emit 50 `step:output` events in <100ms, verify fewer than 50 `publishEvent` calls
7. **Immediate flush**: Emit a deferred event followed by an immediate event, verify both sent (immediate triggers buffer flush)
8. **Listener cleanup** (SC-005): Verify `dispose()` called in both success and error execution paths
9. **Buffer cap**: Emit 200 deferred events without flushing, verify buffer doesn't exceed 100
10. **Dispose flushes**: Verify `dispose()` flushes remaining buffer

**Files**:
| File | Action | Lines |
|------|--------|-------|
| `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts` | Create | ~300 |

**Depends on**: Phase 2

## Dependency Graph

```
Phase 1 (EventForwarder Core)
  ├── Phase 2 (Batching) ── Phase 6 (Tests)
  ├── Phase 3 (JobHandler Integration) ── Phase 4 (Worker Wiring)
  └── Phase 5 (Module Exports)
```

**Parallelizable**: Phases 2, 3, and 5 can be done in parallel after Phase 1. Phase 4 depends on Phase 3. Phase 6 depends on Phase 2.

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Event forwarding failures crash job execution | High | Every `publishEvent` call wrapped in `.catch()` — errors logged at `warn` level, never thrown |
| Executor listener throws and breaks other listeners | Medium | Executor's `ExecutionEventEmitter.emit()` already catches listener errors (events.ts) — double protection |
| Event ordering lost in batch flush | Medium | Sequential sends within each flush. Batch buffer is FIFO. |
| Memory growth from unbounded buffer | Low | Hard cap at 100 events with oldest-drop. Priority events bypass buffer. |
| Duplicate `job:status` events | Medium | `execution:*` events are explicitly skipped — existing `updateJobStatus`/`reportJobResult` remain sole `job:status` publishers |
| Listener not disposed (resource leak) | Medium | `dispose()` called in `finally` block of `executeJob()`, covering both success and error paths |
| Progress exceeds 100% or stays at 0% | Low | `completedPhases` only incremented on `phase:complete`/`phase:error`. Capped at `totalPhases`. Initial progress is 0 (set by `onJobStart`). |

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | **Create** | EventForwarder class: mapping, batching, progress, error handling |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Add `onProgress` option, wire EventForwarder in `executeJob()` |
| `packages/generacy/src/cli/commands/worker.ts` | **Modify** | Wire `onProgress` callback to `heartbeatManager.setCurrentJob()` |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Export `EventForwarder` and `EventForwarderOptions` |
| `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts` | **Create** | Unit tests for event mapping, batching, progress, error handling |

**No changes needed**:
- `client.ts` — `publishEvent()` already exists
- `server.ts` — `POST /api/jobs/:jobId/events` already exists
- `event-bus.ts` — EventBus already handles publishing and SSE
- `heartbeat.ts` — `setCurrentJob()` already accepts progress
- `types.ts` — `JobEventType` and `JobEvent` already defined
- `packages/workflow-engine/` — no changes required

---

*Generated by speckit*
