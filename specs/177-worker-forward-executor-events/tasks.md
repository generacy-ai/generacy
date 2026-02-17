# Tasks: Worker — Forward Executor Events to Orchestrator via REST

**Input**: `spec.md`, `plan.md`, `data-model.md`, `research.md`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

---

## Phase 1: EventForwarder Core — Event Mapping & Forwarding

### T001 [US1] Create EventForwarder class with event mapping logic
**File**: `packages/generacy/src/orchestrator/event-forwarder.ts`
- Define `EventForwarderOptions` interface: `{ client, jobId, totalPhases, logger, onProgress?, batchIntervalMs?, maxBufferSize? }`
- Implement constructor storing options and initializing state (`completedPhases = 0`, `pendingEvents = []`, etc.)
- Implement `connect(executor)` method: call `executor.addEventListener(listener)`, store dispose handle
- Implement `handleEvent(event: ExecutionEvent)` with switch on `event.type`:
  - Skip all `execution:*` events (already handled by `updateJobStatus`/`reportJobResult`)
  - Map `phase:start` → `phase:start` with `{ phaseName, workflowName }`
  - Map `phase:complete` → `phase:complete` with `{ phaseName, workflowName, duration? }`; increment `completedPhases`; invoke `onProgress`
  - Map `phase:error` → `phase:complete` with `{ phaseName, workflowName, error, status: 'failed' }`; increment `completedPhases`; invoke `onProgress`
  - Map `step:start` → `step:start` with `{ stepName, phaseName, workflowName }`
  - Map `step:complete` → `step:complete` with `{ stepName, phaseName, workflowName, duration? }`
  - Map `step:error` → `step:complete` with `{ stepName, phaseName, error, status: 'failed' }`
  - Map `step:output` → `step:output` with `{ stepName, phaseName, message?, data? }`
  - Map `action:start` → `log:append` with `{ message: 'Action started: ...', level: 'info', source: 'action:start' }`
  - Map `action:complete` → `log:append` with `{ message: 'Action completed: ...', level: 'info', source: 'action:complete' }`
  - Map `action:error` → `action:error` with `{ stepName, phaseName, error, data? }`
  - Map `action:retry` → `log:append` with `{ message: 'Retrying action ...', level: 'warn', source: 'action:retry', retryAttempt, maxRetries }`
- Implement `sendEvent(mapped)`: fire-and-forget `client.publishEvent(jobId, event).catch(err => logger.warn(...))`
- Implement error extraction helper: extract message from `event.data` or `event.message`, truncate to 4096 chars
- Implement duration extraction: pull `duration` from `event.data` if present
- Implement progress calculation: `Math.round((completedPhases / totalPhases) * 100)`, cap at 100
- Implement `dispose()`: call `subscription.dispose()`, clear timer, flush pending buffer

### T002 [P] [US1] Export EventForwarder from orchestrator index
**File**: `packages/generacy/src/orchestrator/index.ts`
- Add `export { EventForwarder } from './event-forwarder.js';`
- Add `export type { EventForwarderOptions } from './event-forwarder.js';`

---

## Phase 2: Batching — Reduce HTTP Overhead

### T003 [US4] Add event batching to EventForwarder
**File**: `packages/generacy/src/orchestrator/event-forwarder.ts`
- Define priority classification:
  - **Immediate**: `phase:start`, `phase:complete`, `step:start`, `step:complete`, `action:error`, `phase:error`, `step:error`
  - **Deferred**: `step:output`, `action:start`, `action:complete`, `action:retry`
- Implement buffer management:
  - `pendingEvents: Array<{ type: JobEventType; data: Record<string, unknown>; timestamp: number }>`
  - Hard cap at `maxBufferSize` (default 100); drop oldest deferred event when full with `warn` log
- Implement flush scheduling:
  - Immediate events: flush buffer first (preserves ordering), then send the immediate event
  - Deferred events: push to buffer, schedule `flushBuffer()` after `batchIntervalMs` (default 100ms) if no timer active
  - Size threshold: if buffer reaches 20 events, flush immediately
- Implement `flushBuffer()`:
  - Clear flush timer
  - Send buffered events sequentially via `sendEvent()` (each is fire-and-forget, preserves ordering)
  - Clear `pendingEvents` array
- Ensure `dispose()` calls `flushBuffer()` before clearing subscription

---

## Phase 3: JobHandler Integration — Wire Up EventForwarder

### T004 [US1, US3] Integrate EventForwarder into JobHandler.executeJob()
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions` interface
- Store `onProgress` in constructor alongside existing callbacks (`onJobStart`, `onJobComplete`, `onError`)
- In `executeJob()`:
  - Declare `let forwarder: EventForwarder | undefined;` at the top of the method scope
  - After `prepareWorkflow()` (around line 226), create the forwarder:
    ```typescript
    forwarder = new EventForwarder({
      client: this.client,
      jobId: job.id,
      totalPhases: workflow.phases.length,
      logger: this.logger,
      onProgress: this.onProgress,
    });
    forwarder.connect(executor);
    ```
  - In the `finally` block (around line 274), before clearing `currentJob`:
    ```typescript
    forwarder?.dispose();
    ```
- Add import for `EventForwarder` from `./event-forwarder.js`

---

## Phase 4: Worker Command Wiring — Heartbeat Progress

### T005 [US3] Wire onProgress callback in worker command
**File**: `packages/generacy/src/cli/commands/worker.ts`
- Add `onProgress` to the `JobHandler` construction options (around line 146):
  ```typescript
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  },
  ```
- Verify `heartbeatManager` is in scope at the point of JobHandler construction (it is — defined earlier in the same `action` function)

---

## Phase 5: Unit Tests

### T006 [US1] Write event mapping coverage tests (SC-001)
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Set up test scaffolding with vitest (`describe`, `it`, `expect`, `vi`)
- Create mock `OrchestratorClient` with `vi.fn()` for `publishEvent`
- Create mock executor with `addEventListener` returning a disposable
- Create mock logger with `warn`, `info`, `error`, `debug` methods
- Test each of the 11 forwarded event types:
  - `phase:start` → verify `publishEvent` called with `type: 'phase:start'` and correct data
  - `phase:complete` → verify `type: 'phase:complete'` with `{ phaseName, workflowName, duration }`
  - `phase:error` → verify `type: 'phase:complete'` with `{ error, status: 'failed' }`
  - `step:start` → verify `type: 'step:start'`
  - `step:complete` → verify `type: 'step:complete'`
  - `step:error` → verify `type: 'step:complete'` with `{ error, status: 'failed' }`
  - `step:output` → verify `type: 'step:output'`
  - `action:start` → verify `type: 'log:append'` with `{ level: 'info', source: 'action:start' }`
  - `action:complete` → verify `type: 'log:append'` with `{ level: 'info', source: 'action:complete' }`
  - `action:error` → verify `type: 'action:error'`
  - `action:retry` → verify `type: 'log:append'` with `{ level: 'warn', source: 'action:retry' }`
- Test that `execution:start`, `execution:complete`, `execution:error`, `execution:cancel` do NOT call `publishEvent`

### T007 [P] [US2] Write non-blocking guarantee tests (SC-002)
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Stub `publishEvent` to return `Promise.reject(new Error('network failure'))`
- Emit multiple event types, verify no exception propagates
- Verify `logger.warn` called with forwarding error message
- Verify job execution can complete normally (dispose does not throw)

### T008 [P] [US3] Write progress tracking tests (SC-003)
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Configure EventForwarder with `totalPhases: 4` and mock `onProgress`
- Emit `phase:complete` events one by one
- Verify `onProgress` called with `(jobId, 25)`, `(jobId, 50)`, `(jobId, 75)`, `(jobId, 100)`
- Verify `phase:error` also increments progress
- Verify progress never exceeds 100

### T009 [P] [US4] Write batch efficiency tests (SC-004)
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Emit 50 `step:output` events rapidly (within <100ms)
- Advance timers (use `vi.useFakeTimers()`)
- Verify fewer than 50 `publishEvent` calls made
- Test immediate flush: emit deferred event, then immediate event, verify both sent
- Test buffer cap: emit 200 deferred events without flushing, verify buffer ≤ 100
- Test size threshold: emit 20 deferred events, verify flush triggered

### T010 [P] [US2] Write listener cleanup tests (SC-005)
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Create EventForwarder, connect, then dispose
- Verify `subscription.dispose()` was called
- Verify `dispose()` flushes remaining buffer
- Verify timer is cleared on dispose
- Verify double-dispose is safe (no errors)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (batching extends core)
- Phase 1 must complete before Phase 3 (JobHandler imports EventForwarder)
- Phase 3 must complete before Phase 4 (worker wires onProgress from JobHandler)
- Phase 2 must complete before Phase 5 (tests cover batching behavior)

**Parallel opportunities within phases**:
- T001 and T002 can run in parallel (T002 only adds exports, no dependency on implementation details)
- T006, T007, T008, T009, T010 are independent test suites within the same file — but they target the same file so are best written together; the [P] marker indicates they test independent concerns

**Critical path**:
```
T001 → T003 → T004 → T005
  ↓
T002 (parallel with T001)
  ↓
T006 → T007/T008/T009/T010 (parallel test groups, after T003)
```

**Execution order (recommended)**:
1. T001 — EventForwarder core (mapping + forwarding)
2. T002 — Module exports (parallel with T001)
3. T003 — Batching logic
4. T004 — JobHandler integration
5. T005 — Worker command wiring
6. T006–T010 — Unit tests (can be written as a single file with independent describe blocks)
