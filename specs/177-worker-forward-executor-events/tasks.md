# Tasks: Worker — Forward Executor Events to Orchestrator via REST

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core Event Forwarder Module

### T001 [US1] Create event type mapping constant
**File**: `packages/generacy/src/orchestrator/event-forwarder.ts` (new)
- Define `EVENT_TYPE_MAP: Record<ExecutionEventType, JobEventType>` with all 15 mappings
- Import `ExecutionEventType` from `@generacy-ai/workflow-engine`
- Import `JobEventType` from `./types.js`
- Map terminal execution events (`execution:complete`, `execution:error`, `execution:cancel`) to `log:append` to avoid SSE race condition with `reportJobResult()`
- Map `execution:start` to `job:status`
- Map `phase:error` to `phase:complete` (with error flag in data)
- Map `step:error` to `action:error`
- Map action-level events (`action:start`, `action:complete`, `action:retry`) to `log:append`
- Direct mappings for `phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`

### T002 [US1] Implement data payload builder
**File**: `packages/generacy/src/orchestrator/event-forwarder.ts`
- Create `buildPayload(event: ExecutionEvent, duration?: number): Record<string, unknown>` helper
- Include `workflowName`, `phaseName`, `stepName`, `message` from event (when present)
- Include `duration` for `:complete` events
- For `:error` events mapped to `phase:complete`, include `status: 'error'` and `error` field
- For general `:error` events, extract error from `event.data`
- Safely spread `event.data` when it is a plain object (use `typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data)` guard)
- Strip `undefined` values from the final payload

### T003 [US1, US3] Implement `createEventForwarder()` function
**File**: `packages/generacy/src/orchestrator/event-forwarder.ts`
- Define `EventForwarderOptions` interface: `{ client, jobId, logger, totalPhases, stepsPerPhase, onProgress? }`
- Define `EventForwarderResult` interface: `{ listener, dispose }`
- Export `createEventForwarder(options: EventForwarderOptions): EventForwarderResult`
- **Duration tracking**: Maintain `Map<string, number>` of start timestamps keyed by `phase:${phaseName}`, `step:${phaseName}:${stepName}`, `action:${phaseName}:${stepName}`; compute delta on `:complete` events
- **Progress tracking**: Track `completedPhases`, `completedStepsInCurrentPhase`, `currentPhaseIndex`; compute `effectiveCompleted = completedPhases + (completedSteps / stepsPerPhase[currentPhaseIndex])`; derive `progress = Math.round((effectiveCompleted / totalPhases) * 100)`; clamp to 0–100; force 100 on `execution:complete`
- **Listener function**: Map event type via `EVENT_TYPE_MAP`, build payload via `buildPayload()`, call `client.publishEvent(jobId, { type, data, timestamp }).catch(errorHandler)`; call `onProgress` callback synchronously when progress changes
- **Error logging (rate-limited)**: Track `failureCount` and `firstFailureLogged`; log first failure via `logger.warn()`; suppress subsequent failures; log summary in `dispose()`
- **Dispose function**: Log failure summary if `failureCount > 0`; mark forwarder as disposed so subsequent listener calls are no-ops

---

## Phase 2: Wire into JobHandler

### T004 [US1, US2] Add `onProgress` callback to `JobHandlerOptions`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions` interface
- Store as `private readonly onProgress` in the `JobHandler` class constructor

### T005 [US1, US2] Attach event forwarder in `executeJob()`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add import: `import { createEventForwarder } from './event-forwarder.js';`
- After `prepareWorkflow()` (line 214) and before `executor.execute()` (line 222):
  - Create forwarder: `createEventForwarder({ client: this.client, jobId: job.id, logger: this.logger, totalPhases: workflow.phases.length, stepsPerPhase: workflow.phases.map(p => p.steps.length), onProgress: (progress) => this.onProgress?.(job.id, progress) })`
  - Attach listener: `const subscription = executor.addEventListener(forwarder.listener)`
- In the `finally` block (after line 264):
  - Call `subscription.dispose()` to remove the listener
  - Call `forwarder.dispose()` to log failure summary
- Ensure `subscription` and `forwarder` are declared in the scope visible to `finally` (declare before `try`, assign inside)

---

## Phase 3: Wire Progress to HeartbeatManager

### T006 [P] [US3] Wire `onProgress` in worker command
**File**: `packages/generacy/src/cli/commands/worker.ts`
- Add `onProgress` callback to `JobHandler` options:
  ```
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  }
  ```
- Verify `heartbeatManager` is in scope at the point of `JobHandler` construction (it is — created earlier at ~line 124)

### T007 [P] [US3] Wire `onProgress` in agent command
**File**: `packages/generacy/src/cli/commands/agent.ts`
- Add `onProgress` callback to `JobHandler` options:
  ```
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  }
  ```
- Same pattern as T006

---

## Phase 4: Export Module

### T008 [US1] Export `createEventForwarder` from orchestrator barrel
**File**: `packages/generacy/src/orchestrator/index.ts`
- Add export: `export { createEventForwarder } from './event-forwarder.js';`
- Add type exports: `export type { EventForwarderOptions, EventForwarderResult } from './event-forwarder.js';`

---

## Phase 5: Testing

### T009 [US1] Write tests for event type mapping
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts` (new)
- Test all 15 `ExecutionEventType` values map to the correct `JobEventType`
- Verify `execution:start` → `job:status`
- Verify `execution:complete/error/cancel` → `log:append`
- Verify `phase:error` → `phase:complete`
- Verify `step:error` → `action:error`
- Verify action-level events → `log:append`
- Verify direct mappings (`phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`)

### T010 [US1] Write tests for data payload construction
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Verify `workflowName`, `phaseName`, `stepName`, `message` are included when present
- Verify `event.data` is spread when it's a plain object
- Verify `event.data` is not spread when it's `undefined`, `null`, array, or primitive
- Verify `duration` is included for `:complete` events
- Verify `phase:error` events include `status: 'error'` and `error` in data
- Verify `undefined` values are stripped from payload

### T011 [US1] Write tests for duration calculation
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Emit `phase:start` then `phase:complete` with known timestamps; verify `duration` in forwarded data
- Emit `step:start` then `step:complete`; verify `duration`
- Emit `:complete` without prior `:start`; verify no `duration` (or `undefined`)

### T012 [US3] Write tests for progress calculation
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Configure a 2-phase workflow (phase 1: 2 steps, phase 2: 3 steps)
- Emit `phase:start` for phase 1, then `step:complete` x2, then `phase:complete`; verify progress at each step
- Emit `phase:start` for phase 2, then `step:complete` x3, then `phase:complete`; verify progress reaches near 100
- Emit `execution:complete`; verify `onProgress` called with exactly 100
- Verify progress is clamped to 0–100

### T013 [US2] Write tests for fire-and-forget error handling
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Mock `client.publishEvent` to reject; emit an event; verify no exception propagates to caller
- Verify `logger.warn` is called on first failure
- Mock `client.publishEvent` to reject 10 times; verify `logger.warn` is called only once (first failure), not 10 times
- Call `dispose()`; verify summary warning is logged with failure count

### T014 [US2] Write tests for dispose and cleanup
**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Call `dispose()`; emit subsequent events; verify `publishEvent` is NOT called after dispose
- Verify dispose logs failure summary when `failureCount > 0`
- Verify dispose does not log when `failureCount === 0`

### T015 Run tests and verify
**Files**:
- `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts`
- Run `pnpm test` in `packages/generacy` to verify all new tests pass
- Run full test suite to verify no regressions
- Verify TypeScript compilation with `pnpm build` or `pnpm tsc --noEmit`

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001–T003) must complete before Phase 2 (T004–T005)
- Phase 2 must complete before Phase 3 (T006–T007) and Phase 4 (T008)
- Phase 3 and Phase 4 can run in parallel with each other
- Phase 5 (T009–T015) can begin after Phase 1 for unit tests, but integration verification (T015) requires all phases

**Parallel opportunities within phases**:
- T001 and T002 can be developed in parallel (both are helpers consumed by T003)
- T006 and T007 are marked [P] — independent file changes that can run in parallel
- T009–T014 test different aspects and can be written in parallel

**Critical path**:
T001 → T003 → T005 → T006/T007/T008 → T015

```
T001 ─┐
T002 ─┼→ T003 → T004 → T005 ─┬→ T006 [P] ─┐
      │                       ├→ T007 [P] ──┼→ T015
      │                       └→ T008 ──────┘
      │
      └→ T009–T014 (can start after T003, finalize after T008)
```
