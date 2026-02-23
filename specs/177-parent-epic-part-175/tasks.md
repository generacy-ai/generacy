# Tasks: Forward Executor Events to Orchestrator

**Input**: spec.md, plan.md, clarifications.md
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Event Type Mapping & Forwarder Infrastructure

### T001 Add EVENT_TYPE_MAP constant to job-handler.ts
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add `import type { ExecutionEvent } from '@generacy-ai/workflow-engine'` to imports
- Add `import type { JobEventType } from './types.js'` if not already imported
- Define `EVENT_TYPE_MAP: Partial<Record<string, JobEventType>>` constant after existing imports/constants
- Map 7 forwarded events: `phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`, `action:error`, `action:retry` → `action:error`
- Skip 7 events: all `execution:*`, `phase:error`, `step:error`, `action:start`, `action:complete`

### T002 Implement createEventForwarder() function
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Define `EventForwarder` interface with `enqueue()`, `flush()`, `stop()` methods
- Implement `createEventForwarder(client, jobId, logger)` factory function
- Implement array-based FIFO queue with sequential `drain()` loop
- Ensure `enqueue()` is synchronous (fire-and-forget `void drain()`)
- Add non-blocking error handling: catch publishEvent errors, never throw
- Add log throttling: first failure at `warn`, subsequent at `debug`, reset on success
- Add `stop()` method that sets stopped flag and clears queue
- Add `flush()` method that awaits drain completion

---

## Phase 2: Wire Up Event Forwarding in executeJob()

### T003 Register event listener and progress tracking in executeJob()
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- After executor creation (~line 310), before existing addEventListener (~line 330):
  - Calculate `totalSteps` from `workflow.phases.reduce((sum, p) => sum + p.steps.length, 0)`
  - Initialize `completedSteps = 0` counter
  - Create forwarder instance via `createEventForwarder(this.client, job.id, this.logger)`
  - Add second `addEventListener` callback on executor
- In the callback:
  - Look up `EVENT_TYPE_MAP[event.type]`, return early if undefined
  - Build `data` payload: `workflowName`, optional `phaseName`, `stepName`, `message`, `detail`
  - On `step:complete`: increment `completedSteps`, attach `progress` percentage to data
  - Call `forwarder.enqueue({ type, data, timestamp })`

### T004 Add cleanup in finally block
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- In the `finally` block of `executeJob()` (~line 416), before existing cleanup:
  - Call `forwarder.stop()` to prevent further enqueueing and clear remaining queue
  - Call `forwarderSubscription.dispose()` to unregister the event listener
- Ensure variables `forwarder` and `forwarderSubscription` are declared in scope accessible to both try and finally blocks

---

## Phase 3: Testing

### T005 Add unit tests for event forwarding
**File**: `packages/generacy/src/orchestrator/__tests__/job-handler.test.ts`
- Add `publishEvent: vi.fn()` to `mockClient` setup
- Add new `describe('event forwarding')` block with the following tests:

### T005a Test: forward phase:start events to orchestrator
- Emit a `phase:start` event from executor
- Verify `publishEvent` called with correct jobId, mapped type, and data payload

### T005b Test: forward step:complete events with progress
- Emit `step:complete` events for a workflow with known total steps
- Verify `progress` field in data reflects `completedSteps / totalSteps * 100`

### T005c Test: do not forward execution:* events
- Emit `execution:start`, `execution:complete`, `execution:error`, `execution:cancel`
- Verify `publishEvent` is NOT called for any of them

### T005d Test: do not forward phase:error or step:error
- Emit `phase:error` and `step:error` events
- Verify `publishEvent` is NOT called (redundant with completion events)

### T005e Test: map action:retry to action:error
- Emit an `action:retry` event
- Verify `publishEvent` called with type `action:error`

### T005f Test: non-blocking error handling
- Make `publishEvent` reject with an error
- Verify job execution still completes successfully
- Verify the error does not propagate to the executor or job handler

### T005g Test: log throttling on forwarding failures
- Make `publishEvent` reject multiple times
- Verify first failure logged at `warn`, subsequent at `debug`
- Make `publishEvent` succeed, then fail again
- Verify warn is logged again after success reset

### T005h Test: preserve event ordering
- Emit multiple events rapidly
- Verify `publishEvent` calls are in the same order as emitted events

### T005i Test: progress calculation as completedSteps/totalSteps
- Use a workflow with 2 phases, 3 total steps
- Verify progress: 33% after step 1, 67% after step 2, 100% after step 3

### T005j Test: stop forwarding after forwarder.stop()
- Emit events, then call stop
- Verify no further `publishEvent` calls after stop
- Verify queue is cleared

---

## Phase 4: Verification

### T006 Type-check and lint
**Files**:
- `packages/generacy/src/orchestrator/job-handler.ts`
- `packages/generacy/src/orchestrator/__tests__/job-handler.test.ts`
- Run `pnpm tsc --noEmit` to verify no type errors
- Run `pnpm lint` to verify no linting issues

### T007 Run full test suite
**Files**:
- `packages/generacy/src/orchestrator/__tests__/job-handler.test.ts`
- Run `pnpm test` (or `pnpm vitest run`) for the orchestrator package
- Ensure all existing tests still pass (no regressions)
- Ensure all new event forwarding tests pass

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (forwarder infrastructure needed before wiring)
- Phase 2 must complete before Phase 3 (tests need implementation to test against)
- Phase 3 must complete before Phase 4 (verification validates everything)

**Parallel opportunities within phases**:
- T001 and T002 are in the same file but T002 depends on the types/map from T001 — implement sequentially
- T003 and T004 are sequential (T004 cleans up what T003 creates)
- T005a–T005j can be written together as a single test block but logically cover distinct behaviors

**Critical path**:
T001 → T002 → T003 → T004 → T005 → T006 → T007

**Notes**:
- No changes needed to `client.ts` — `publishEvent()` already exists
- No changes needed to `types.ts` — `JobEventType` already includes all needed event types
- No new files or dependencies required
- ~120 lines of production code, ~200 lines of test code
