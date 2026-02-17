# Tasks: Worker: Forward Executor Events to Orchestrator via REST

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Type Exports and Event Mapping Foundation

### T001 [US1] Re-export executor event types from orchestrator types
**File**: `packages/generacy/src/orchestrator/types.ts`
- Add `export type { ExecutionEventType, ExecutionEvent, ExecutionEventListener } from '@generacy-ai/workflow-engine'` to the types file
- These re-exports give `job-handler.ts` a clean import path and keep workflow-engine types co-located with orchestrator types

### T002 [P] [US1] Define executor-to-orchestrator event type mapping constant
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add imports for `ExecutionEventType` from `@generacy-ai/workflow-engine` and `JobEventType` from `./types.js`
- Define module-level `const EXECUTOR_TO_JOB_EVENT: Record<ExecutionEventType, JobEventType | null>` mapping:
  - `execution:*` → `null` (skip — redundant with existing status/result calls)
  - `phase:start` → `'phase:start'`, `phase:complete` → `'phase:complete'`, `phase:error` → `'log:append'`
  - `step:start` → `'step:start'`, `step:complete` → `'step:complete'`, `step:error` → `'log:append'`, `step:output` → `'step:output'`
  - `action:start` → `'log:append'`, `action:complete` → `'log:append'`, `action:error` → `'action:error'`, `action:retry` → `'log:append'`

---

## Phase 2: Progress Callback Infrastructure

### T003 [US3] Add `onProgress` callback to `JobHandlerOptions` and class
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions` interface (after `onError`)
- Add matching `private readonly onProgress?` field to the `JobHandler` class
- Assign from options in the constructor

### T004 [US3] Wire `onProgress` callback in worker command
**File**: `packages/generacy/src/cli/commands/worker.ts`
- Add `onProgress` callback to the `JobHandler` constructor call (alongside existing `onJobStart`/`onJobComplete`/`onError`)
- Implementation: `onProgress: (jobId, progress) => { heartbeatManager.setCurrentJob(jobId, progress); }`
- This uses the existing `HeartbeatManager.setCurrentJob(jobId, progress?)` method which already accepts an optional progress parameter

---

## Phase 3: Core Event Forwarding Logic

### T005 [US1, US2] Implement event subscription and forwarding in `executeJob()`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add imports: `ExecutionEvent` and `ExecutionEventListener` types from `@generacy-ai/workflow-engine`
- **Before the try block** (after branch tracking, ~line 191): Declare `let subscription: { dispose: () => void } | undefined`
- **After executor creation and human handler injection** (~line 230, before `executor.execute()`): Set up the event listener:
  - Compute `totalPhases` from `workflow.phases.length`
  - Initialize `let completedPhases = 0`
  - Initialize `const forwardedPhaseErrors = new Set<string>()` for deduplication (D5)
  - Call `subscription = executor.addEventListener((event) => { ... })` with a **synchronous** listener (D2)
- **Inside the listener callback**:
  1. Look up `mappedType` from `EXECUTOR_TO_JOB_EVENT[event.type]` — return early if `null`/`undefined` (skips `execution:*` events per FR-005)
  2. Deduplicate `phase:error`: check/add `event.phaseName` in `forwardedPhaseErrors` Set (D5)
  3. Build curated `data: Record<string, unknown>` with only `phaseName`, `stepName`, `message` (D4)
  4. For `phase:complete` and `step:complete`: extract `duration` from `event.data` if present
  5. For `log:append` mapped events: add `level` field — `'error'` for `*:error`, `'warn'` for `action:retry`, `'info'` otherwise
  6. On `phase:complete`: increment `completedPhases`, compute `Math.min(Math.round((completedPhases / totalPhases) * 100), 99)`, call `this.onProgress?.(job.id, progress)` — capped at 99 per D3
  7. Fire-and-forget forward: `void this.client.publishEvent(job.id, { type: mappedType, data, timestamp: event.timestamp }).catch(...)` (D2)
  8. In the `.catch()`: log at warn level with event type, job ID, and error (FR-003, US2)

### T006 [US2, US1] Dispose event subscription in finally block
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- In the `finally` block (~line 273), add `subscription?.dispose()` as the **first statement** before branch restore logic
- This ensures cleanup happens even if `executor.execute()` throws (FR-010, SC-005)
- The optional chaining handles the case where executor creation failed before subscription was assigned

---

## Phase 4: Testing

### T007 [US1, US2, US3] Write unit tests for event forwarding
**File**: `packages/generacy/tests/unit/orchestrator/job-handler-events.test.ts` (new)
- Create the test directory `packages/generacy/tests/unit/orchestrator/` if needed
- Set up test infrastructure:
  - Mock `OrchestratorClient` with spy on `publishEvent`, `updateJobStatus`, `reportJobResult`, `heartbeat`
  - Mock `WorkflowExecutor` that exposes `addEventListener` and a way to manually emit events
  - Mock workflow with configurable phase count
  - Mock logger with spy on `warn`
- **Test cases** (9 tests corresponding to success criteria):

  1. **SC-001 — Event coverage**: Mock executor emits all 15 event types → verify `publishEvent` called for each of the 11 non-execution events with correctly mapped `JobEventType`
  2. **Execution events skipped**: Emit `execution:start`, `execution:complete`, `execution:error`, `execution:cancel` → verify `publishEvent` NOT called
  3. **SC-002 — Non-blocking guarantee**: Configure `publishEvent` to reject with an error → verify `executeJob()` still resolves successfully and the job result is reported
  4. **Curated event data (D4)**: Emit events with large `data` objects (e.g., full `PhaseResult`) → verify forwarded `data` contains only `phaseName`, `stepName`, `duration`, `message`, `level` — NOT nested `stepResults`/`outputs`
  5. **SC-003 — Progress accuracy**: Emit N `phase:complete` events for a workflow with N phases → verify `onProgress` called with correct percentages (e.g., 33, 67, 99 for 3 phases)
  6. **Progress caps at 99**: All phases complete → verify progress never exceeds 99 (reaches 100 only via separate execution completion path)
  7. **D5 — Duplicate phase:error deduplication**: Emit two `phase:error` events for the same `phaseName` → verify `publishEvent` called only once for that phase error
  8. **SC-005 — Subscription disposal**: Verify `dispose()` called in finally block — test both success and error paths
  9. **Log:append level mapping**: Verify `phase:error` / `step:error` → `level: 'error'`, `action:retry` → `level: 'warn'`, `action:start` / `action:complete` → `level: 'info'`

---

## Phase 5: Verification

### T008 [US1, US2, US3] Run tests and verify TypeScript compilation
**Files**:
- `packages/generacy/tests/unit/orchestrator/job-handler-events.test.ts`
- `packages/generacy/src/orchestrator/job-handler.ts`
- `packages/generacy/src/orchestrator/types.ts`
- `packages/generacy/src/cli/commands/worker.ts`
- Run `pnpm --filter generacy exec tsc --noEmit` to verify no type errors
- Run `pnpm --filter generacy test` (or `vitest run`) to verify all tests pass
- Verify no regressions in existing `cli.test.ts` tests

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 3 (mapping constant needed for forwarding logic)
- Phase 2 must complete before Phase 3 (T005 uses `onProgress` callback)
- Phase 3 must complete before Phase 4 (tests verify implementation)
- Phase 4 must complete before Phase 5 (verification runs the tests)

**Parallel opportunities within phases**:
- T001 and T002 can run in parallel (different files, no dependency)
- T003 and T004 are sequential (T004 depends on T003 adding the option)

**Critical path**:
T001 → T005 → T006 → T007 → T008
T002 ───┘
T003 → T004 → T005

**Estimated file changes**:
- `types.ts`: ~1 line added
- `job-handler.ts`: ~60 lines added (mapping const + options + listener + disposal)
- `worker.ts`: ~3 lines added (onProgress callback)
- `job-handler-events.test.ts`: ~200-300 lines (new file, 9 test cases)
