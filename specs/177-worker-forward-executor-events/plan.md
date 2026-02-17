# Implementation Plan: Worker: Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17

## Summary

This plan implements real-time event forwarding from the `WorkflowExecutor` to the orchestrator inside `JobHandler.executeJob()`. After the executor is created and before `executor.execute()` is called, we subscribe to executor events via `addEventListener()`, map them from `ExecutionEventType` to `JobEventType`, and forward them via the existing `client.publishEvent()` REST endpoint. Progress tracking is updated via a new `onProgress` callback that feeds into the `HeartbeatManager`. The event listener is disposed in the `finally` block to prevent memory leaks.

## Technical Context

- **Language**: TypeScript (ESM, Node.js >=20)
- **Test framework**: Vitest
- **Packages modified**:
  - `packages/generacy/src/orchestrator/job-handler.ts` — primary implementation
  - `packages/generacy/src/orchestrator/types.ts` — re-export types for convenience
- **Dependencies**: No new dependencies required
- **Existing infrastructure**: `client.publishEvent()` already exists with the correct signature (`POST /api/jobs/:jobId/events`)

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ JobHandler.executeJob()                                     │
│                                                             │
│  ┌─────────────┐    addEventListener()    ┌──────────────┐  │
│  │  Workflow    │ ──────────────────────▶  │   Event      │  │
│  │  Executor    │    ExecutionEvent        │   Listener   │  │
│  └─────────────┘                          └──────┬───────┘  │
│                                                  │          │
│                              mapEventType()      │          │
│                              buildEventData()    │          │
│                                                  ▼          │
│                                           ┌──────────────┐  │
│                                           │ publishEvent │  │
│                                           │ (fire & forget│  │
│                                           │  with catch)  │  │
│                                           └──────┬───────┘  │
│                                                  │          │
│                              onProgress()        │          │
│                              (phase:complete)    │          │
│                                                  ▼          │
│                                           ┌──────────────┐  │
│                                           │ Orchestrator │  │
│                                           │ REST API     │  │
│                                           └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Key Technical Decisions

### D1: Progress updates via `onProgress` callback (Q1 — Option B)

**Decision**: Add an `onProgress?: (jobId: string, progress: number) => void` callback to `JobHandlerOptions`.

**Rationale**: This maintains the existing decoupled architecture pattern established by `onJobStart`/`onJobComplete`/`onError`. The `worker.ts` wiring code calls `heartbeatManager.setCurrentJob(jobId, progress)` in the callback. No new dependency from `JobHandler` to `HeartbeatManager`.

### D2: Synchronous listener with void catch pattern (Q2 — Option B)

**Decision**: Use a synchronous listener that calls `void this.client.publishEvent(...).catch(...)`.

**Rationale**: The `ExecutionEventListener` type is `(event: ExecutionEvent) => void`. Using an async function creates a type mismatch (returns `Promise<void>` instead of `void`). While the emitter's try/catch would catch synchronous errors, an async function's rejection is only caught within the async function itself. The `void promise.catch(...)` pattern is explicit about fire-and-forget intent and matches the type signature correctly.

### D3: Count skipped phases as completed for progress (Q3 — Option A)

**Decision**: Increment `completedPhases` for both `phase:complete` and skipped phases.

**Rationale**: Looking at the executor code, skipped phases return early from `executePhase()` **without** emitting `phase:complete`. They only emit `phase:start`. However, the finalization block at line 347 emits `phase:complete` or `phase:error` based on `result.status`. Since skipped phases return early (line 280) **before** the finalization block, they never emit a completion event. This means we need to track skipped phases separately — detect via `phase:start` followed by no completion within a reasonable time, OR simply track progress at the `phase:complete` level and accept that skipped phases don't contribute (since the executor doesn't emit completion events for them). The simplest correct approach: count `phase:complete` events only, and set progress to 100 when execution finishes (in the `onJobComplete` callback path).

**Revised approach**: Track `completedPhases` on `phase:complete` only. After `executor.execute()` returns, set progress to 100 via the existing result-reporting flow. This is accurate for phases that actually run and naturally handles skipped phases.

### D4: Curated fields only for event data (Q4 — Option A)

**Decision**: Extract only `phaseName`, `stepName`, `duration`, `message` from events. Do not spread `event.data`.

**Rationale**: Completion events carry full `PhaseResult`/`StepResult` objects including nested `stepResults`, `outputs`, etc. This would create unnecessarily large HTTP payloads. Curated fields keep payloads predictable and small.

### D5: Deduplicate phase errors in the forwarder (Q5 — Option A)

**Decision**: Track which phases have already had an error event forwarded and skip duplicates.

**Rationale**: The executor emits `phase:error` in both the catch block (line 331) and the finalization block (line 347-348) when `result.status !== 'completed'`. This is an upstream behavior we shouldn't modify in this feature. A simple `Set<string>` tracking `${phaseName}:error` prevents duplicate forwards.

### D6: Subscription declared at method scope (Q6 — Option A)

**Decision**: Declare `let subscription: { dispose: () => void } | undefined` before the try block. Dispose in finally with `subscription?.dispose()`.

**Rationale**: The subscription must be accessible in the finally block for proper cleanup. Declaring at method scope with optional chaining is clean and idiomatic.

### D7: Unbounded concurrency for event forwarding (Q7 — Option A)

**Decision**: Let all `publishEvent` calls fire concurrently with no queue or limit.

**Rationale**: Events are fire-and-forget. The orchestrator's `publishEvent` endpoint is lightweight (in-memory EventBus publish). If the orchestrator is slow, events will naturally fail and be caught/logged. This matches the spec's fire-and-forget philosophy. Batching (FR-008/009) is explicitly P3/deferred.

### D8: Forward `step:output` individually, no special handling (Q8 — Option A)

**Decision**: Treat `step:output` the same as other events.

**Rationale**: Simplest approach. Volume is unlikely to be a problem for the initial implementation since workflow steps are typically not high-frequency streamers. Optimization can be added later with the P3 batching feature.

### D9: Inline const map at module level (Q9 — Option C)

**Decision**: Define a `Record<ExecutionEventType, JobEventType | null>` constant at module level in `job-handler.ts`.

**Rationale**: A lookup table is the simplest, most readable approach. No function call overhead, easy to verify correctness at a glance, and testable through the integration of the forwarding behavior.

### D10: Mock executor events for testing (Q10 — Option B)

**Decision**: Create a mock executor that exposes `addEventListener` and manually emits events. Test forwarding logic in isolation.

**Rationale**: The `generacy` package has no existing test files for the orchestrator module. Mock-based tests are fast, focused, and don't require setting up real workflow definitions. The event mapping is a simple lookup table that can be verified through the mock-emit-and-verify pattern.

## Implementation Phases

### Phase 1: Type exports and event mapping (types.ts)

**File**: `packages/generacy/src/orchestrator/types.ts`

1. Import and re-export `ExecutionEventType` and `ExecutionEvent` from `@generacy-ai/workflow-engine`
2. This is purely for convenience and type-safety in `job-handler.ts`

**Changes**:
```typescript
// Add at the top of types.ts
export type { ExecutionEventType, ExecutionEvent } from '@generacy-ai/workflow-engine';
```

### Phase 2: Add `onProgress` callback to JobHandlerOptions (job-handler.ts)

**File**: `packages/generacy/src/orchestrator/job-handler.ts`

1. Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions` interface
2. Store callback in the class constructor
3. Add as a private readonly field

**Changes to `JobHandlerOptions`**:
```typescript
/** Callback for progress updates */
onProgress?: (jobId: string, progress: number) => void;
```

### Phase 3: Event mapping constant (job-handler.ts)

**File**: `packages/generacy/src/orchestrator/job-handler.ts`

Define the event type mapping at module level:

```typescript
import type { ExecutionEventType } from '@generacy-ai/workflow-engine';
import type { JobEventType } from './types.js';

/** Maps executor event types to orchestrator job event types. null = skip. */
const EXECUTOR_TO_JOB_EVENT: Record<ExecutionEventType, JobEventType | null> = {
  'execution:start': null,
  'execution:complete': null,
  'execution:error': null,
  'execution:cancel': null,
  'phase:start': 'phase:start',
  'phase:complete': 'phase:complete',
  'phase:error': 'log:append',
  'step:start': 'step:start',
  'step:complete': 'step:complete',
  'step:error': 'log:append',
  'step:output': 'step:output',
  'action:start': 'log:append',
  'action:complete': 'log:append',
  'action:error': 'action:error',
  'action:retry': 'log:append',
};
```

### Phase 4: Event forwarding logic in `executeJob()` (job-handler.ts)

**File**: `packages/generacy/src/orchestrator/job-handler.ts`

This is the core change. Inside `executeJob()`:

1. **Before the try block**: Declare `subscription` variable at method scope
2. **After executor creation, before `executor.execute()`**: Subscribe to events
3. **In the finally block**: Dispose subscription

**Implementation**:

```typescript
private async executeJob(job: Job): Promise<void> {
  this.currentJob = job;
  this.abortController = new AbortController();
  const startTime = Date.now();
  const jobWorkdir = job.workdir ?? this.workdir;

  // ... existing branch tracking code ...

  // Event subscription — declared at method scope for finally-block access
  let subscription: { dispose: () => void } | undefined;

  this.logger.info(`Starting job: ${job.id} (${job.name})`);
  this.onJobStart?.(job);

  try {
    // ... existing status update, workflow loading, executor creation ...

    // Subscribe to executor events for forwarding
    const totalPhases = workflow.phases.length;
    let completedPhases = 0;
    const forwardedPhaseErrors = new Set<string>();

    subscription = executor.addEventListener((event) => {
      // Skip execution-level events (redundant with updateJobStatus/reportJobResult)
      const mappedType = EXECUTOR_TO_JOB_EVENT[event.type];
      if (mappedType === null || mappedType === undefined) return;

      // Deduplicate phase:error emissions
      if (event.type === 'phase:error') {
        const key = event.phaseName ?? 'unknown';
        if (forwardedPhaseErrors.has(key)) return;
        forwardedPhaseErrors.add(key);
      }

      // Build curated event data
      const data: Record<string, unknown> = {};
      if (event.phaseName) data.phaseName = event.phaseName;
      if (event.stepName) data.stepName = event.stepName;
      if (event.message) data.message = event.message;

      // Extract duration from completion events
      if (
        (event.type === 'phase:complete' || event.type === 'step:complete') &&
        typeof event.data === 'object' && event.data !== null
      ) {
        const result = event.data as Record<string, unknown>;
        if ('duration' in result) data.duration = result.duration;
      }

      // For log:append mapped events, include level
      if (mappedType === 'log:append') {
        if (event.type.includes('error')) {
          data.level = 'error';
        } else if (event.type === 'action:retry') {
          data.level = 'warn';
        } else {
          data.level = 'info';
        }
      }

      // Update progress on phase completion
      if (event.type === 'phase:complete') {
        completedPhases++;
        const progress = Math.min(
          Math.round((completedPhases / totalPhases) * 100),
          99 // Cap at 99 until execution fully completes
        );
        this.onProgress?.(job.id, progress);
      }

      // Forward — fire-and-forget
      void this.client.publishEvent(job.id, {
        type: mappedType,
        data,
        timestamp: event.timestamp,
      }).catch((err) => {
        this.logger.warn(`Failed to forward executor event: ${event.type} for job ${job.id}: ${err}`);
      });
    });

    // Execute workflow
    const result = await executor.execute(/* ... existing args ... */);

    // ... existing result building and reporting ...
  } catch (error) {
    // ... existing error handling ...
  } finally {
    // Dispose event subscription to prevent memory leaks
    subscription?.dispose();

    // ... existing branch restore, cleanup, resume polling ...
  }
}
```

### Phase 5: Wire `onProgress` in worker.ts

**File**: `packages/generacy/src/cli/commands/worker.ts`

Add the `onProgress` callback when creating the `JobHandler`:

```typescript
const jobHandler = new JobHandler({
  // ... existing options ...
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  },
});
```

### Phase 6: Unit tests

**File**: `packages/generacy/tests/unit/orchestrator/job-handler-events.test.ts` (new file)

Tests to write:

1. **Event coverage (SC-001)**: Mock executor emits all 15 event types → verify `publishEvent` called for each non-execution event with correct mapped type
2. **Execution events skipped**: Verify `execution:start`, `execution:complete`, `execution:error`, `execution:cancel` do NOT trigger `publishEvent`
3. **Non-blocking guarantee (SC-002)**: `publishEvent` rejects → verify `executeJob` still completes successfully
4. **Event data is curated (D4)**: Verify forwarded events contain only `phaseName`, `stepName`, `duration`, `message`, `level` — not full `PhaseResult`/`StepResult`
5. **Progress accuracy (SC-003)**: Emit N `phase:complete` events → verify `onProgress` called with correct percentages
6. **Progress caps at 99 (D3)**: Even with all phases complete, progress should not exceed 99 before execution completes
7. **Duplicate phase:error deduplication (D5)**: Emit two `phase:error` events for same phase → verify `publishEvent` called only once
8. **Subscription disposal (SC-005)**: Verify `dispose()` called in finally block (even on error)
9. **Log:append level mapping**: Verify `phase:error` → `level: 'error'`, `action:retry` → `level: 'warn'`, `action:start` → `level: 'info'`

## Files Changed

| File | Type | Description |
|---|---|---|
| `packages/generacy/src/orchestrator/types.ts` | Modified | Re-export `ExecutionEventType` and `ExecutionEvent` |
| `packages/generacy/src/orchestrator/job-handler.ts` | Modified | Event subscription, mapping, forwarding, progress, and disposal |
| `packages/generacy/src/cli/commands/worker.ts` | Modified | Wire `onProgress` callback to `HeartbeatManager` |
| `packages/generacy/tests/unit/orchestrator/job-handler-events.test.ts` | New | Unit tests for event forwarding |

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| `publishEvent` failures block execution | High | All calls wrapped in `void promise.catch()` — errors only logged at warn level |
| Memory leak from undisposed listener | High | `subscription?.dispose()` in finally block — always runs |
| Duplicate phase:error events pollute orchestrator | Low | `forwardedPhaseErrors` Set deduplicates per phase name |
| Large payloads from spreading event.data | Medium | Curated fields only — no object spread |
| Skipped phases break progress calculation | Low | Progress tracks `phase:complete` only; capped at 99 until execution completes |
| Type mismatch between sync listener and async work | Low | Synchronous listener with `void promise.catch()` matches `ExecutionEventListener` type |
| High `step:output` volume | Low | Deferred to P3 batching. Initial implementation is fire-and-forget per event |

## Out of Scope (Deferred)

- Event batching/buffering (FR-008, FR-009) — P3, follow-up ticket
- Retry logic for failed `publishEvent` calls — fire-and-forget by design
- WebSocket transport — REST is the chosen transport
- Orchestrator-side event storage — handled by #176
- Fixing upstream duplicate `phase:error` emission — handled defensively with deduplication

---

*Generated by speckit*
