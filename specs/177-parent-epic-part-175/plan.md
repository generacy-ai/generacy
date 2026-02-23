# Implementation Plan: Forward Executor Events to Orchestrator

**Issue**: #177 (Part of #175 — Real-time workflow monitoring)
**Branch**: `177-parent-epic-part-175`
**Date**: 2026-02-23

## Summary

Forward `phase:*`, `step:*`, and `action:*` events from the `WorkflowExecutor` event emitter to the orchestrator via the existing `publishEvent()` client method. This enables real-time monitoring dashboards to display granular phase/step/action progress during workflow execution.

The implementation adds an event forwarding system with an async sequential queue (guaranteeing event ordering), progress calculation based on step completion, and non-blocking error handling — all within the existing `JobHandler.executeJob()` method.

## Technical Context

- **Language**: TypeScript (Node.js)
- **Package**: `packages/generacy/src/orchestrator/`
- **Test framework**: Vitest
- **Key types**: `ExecutionEvent` (workflow-engine), `JobEventType` (orchestrator types)
- **Existing infrastructure**: `OrchestratorClient.publishEvent()` already exists (`POST /api/jobs/:jobId/events`)

## Architecture Overview

```
WorkflowExecutor                  JobHandler                    Orchestrator
     │                                │                              │
     │  ExecutionEvent                │                              │
     ├──────────────────────────────►│                              │
     │  (addEventListener callback)   │                              │
     │                                │  filter + map event          │
     │                                │  enqueue to async queue      │
     │                                │                              │
     │                                │  drain loop (sequential)     │
     │                                ├────────────────────────────►│
     │                                │  POST /api/jobs/:id/events   │
     │                                │                              │
     │                                │  update progress counter     │
     │                                │  (completedSteps/totalSteps) │
     │                                │                              │
```

## Files to Modify

| File | Change | Lines |
|------|--------|-------|
| `packages/generacy/src/orchestrator/job-handler.ts` | Add event forwarding logic, progress tracking, queue drain | ~120 new lines |
| `packages/generacy/src/orchestrator/types.ts` | Re-export `ExecutionEventType` for mapping reference | ~2 lines |
| `packages/generacy/src/orchestrator/__tests__/job-handler.test.ts` | Add tests for event forwarding, mapping, progress, queue | ~200 new lines |

**No changes needed** to `client.ts` — `publishEvent()` already exists at line 185.

## Implementation Phases

### Phase 1: Event Type Mapping & Filtering

**Goal**: Define which executor events get forwarded and how they map to orchestrator `JobEventType`.

**Event mapping** (ExecutionEventType → JobEventType):

| Executor Event | Orchestrator Event | Forward? | Rationale |
|---|---|---|---|
| `execution:start` | — | **No** | Covered by `updateJobStatus('running')` (Q1) |
| `execution:complete` | — | **No** | Covered by `reportJobResult()` (Q1) |
| `execution:error` | — | **No** | Covered by `reportJobResult()` (Q1) |
| `execution:cancel` | — | **No** | Covered by `reportJobResult()` (Q1) |
| `phase:start` | `phase:start` | **Yes** | Direct 1:1 mapping |
| `phase:complete` | `phase:complete` | **Yes** | Direct 1:1 mapping |
| `phase:error` | — | **No** | Redundant with `phase:complete` carrying failure status (Q3) |
| `step:start` | `step:start` | **Yes** | Direct 1:1 mapping |
| `step:complete` | `step:complete` | **Yes** | Direct 1:1 mapping |
| `step:error` | — | **No** | Redundant with `step:complete` carrying failure status (Q3) |
| `step:output` | `step:output` | **Yes** | Streaming stdout/stderr |
| `action:start` | — | **No** | Too granular for orchestrator events (no matching JobEventType) |
| `action:complete` | — | **No** | Too granular for orchestrator events (no matching JobEventType) |
| `action:error` | `action:error` | **Yes** | Action-level errors are meaningful |
| `action:retry` | `action:error` | **Yes** | Retries indicate transient failures worth surfacing |

**Implementation in `job-handler.ts`**:

```typescript
import type { ExecutionEvent } from '@generacy-ai/workflow-engine';
import type { JobEventType } from './types.js';

/** Map executor event types to orchestrator JobEventType. Returns undefined for events we don't forward. */
const EVENT_TYPE_MAP: Partial<Record<string, JobEventType>> = {
  'phase:start': 'phase:start',
  'phase:complete': 'phase:complete',
  'step:start': 'step:start',
  'step:complete': 'step:complete',
  'step:output': 'step:output',
  'action:error': 'action:error',
  'action:retry': 'action:error',
};
```

### Phase 2: Async Event Queue with Sequential Processing

**Goal**: Guarantee event ordering while avoiding unhandled promise rejections (Q2).

The queue is a simple array-based FIFO with a self-draining async loop:

```typescript
interface EventForwarder {
  enqueue(event: { type: JobEventType; data: Record<string, unknown>; timestamp: number }): void;
  flush(): Promise<void>;
  stop(): void;
}

function createEventForwarder(
  client: OrchestratorClient,
  jobId: string,
  logger: Logger,
): EventForwarder {
  const queue: Array<{ type: JobEventType; data: Record<string, unknown>; timestamp: number }> = [];
  let draining = false;
  let stopped = false;
  let hasLoggedFailure = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !stopped) {
        const event = queue.shift()!;
        try {
          await client.publishEvent(jobId, event);
          hasLoggedFailure = false; // Reset on success (Q5)
        } catch (error) {
          // Non-blocking: log and continue (Q5)
          const msg = error instanceof Error ? error.message : String(error);
          if (!hasLoggedFailure) {
            logger.warn(`Event forwarding failed for job ${jobId}: ${msg}`);
            hasLoggedFailure = true;
          } else {
            logger.debug(`Event forwarding failed for job ${jobId}: ${msg}`);
          }
        }
      }
    } finally {
      draining = false;
    }
  }

  return {
    enqueue(event) {
      if (stopped) return;
      queue.push(event);
      void drain();
    },
    async flush() {
      await drain();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
  };
}
```

**Key design decisions**:
- **Sequential drain**: `drain()` processes one event at a time, awaiting each `publishEvent()` call before the next. This guarantees ordering.
- **Non-blocking**: The `enqueue()` call is synchronous (fire-and-forget `void drain()`). The executor callback is never awaited.
- **Log throttling** (Q5): First failure per job logs at `warn`, subsequent at `debug`. Resets on success.
- **Stop flag** (Q8): On cancellation, `stop()` prevents further enqueueing and clears the queue.

### Phase 3: Event Listener Registration in `executeJob()`

**Goal**: Wire up the executor's event emitter to the forwarding queue.

Add a **second** `addEventListener` call after executor creation (keeping the existing phase-gate listener intact):

```typescript
// After line 310 (executor creation), before existing addEventListener at line 330:

// --- Event forwarding to orchestrator ---
const totalSteps = workflow.phases.reduce((sum, p) => sum + p.steps.length, 0);
let completedSteps = 0;

const forwarder = createEventForwarder(this.client, job.id, this.logger);
const forwarderSubscription = executor.addEventListener((event) => {
  const mappedType = EVENT_TYPE_MAP[event.type];
  if (!mappedType) return; // Skip unmapped events (execution:*, phase:error, step:error, action:start/complete)

  // Build event data payload
  const data: Record<string, unknown> = {
    workflowName: event.workflowName,
  };
  if (event.phaseName) data.phaseName = event.phaseName;
  if (event.stepName) data.stepName = event.stepName;
  if (event.message) data.message = event.message;
  if (event.data !== undefined) data.detail = event.data;

  // Track progress (Q4: equal weight per step)
  if (event.type === 'step:complete') {
    completedSteps++;
    data.progress = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
  }

  forwarder.enqueue({
    type: mappedType,
    data,
    timestamp: event.timestamp,
  });
});
```

**Progress calculation** (Q4, Q7):
- Extract `totalSteps` from `workflow.phases` before execution starts (closure capture, Q7).
- Increment `completedSteps` on each `step:complete` event.
- Progress = `completedSteps / totalSteps * 100`, rounded to integer.
- Included in the `step:complete` event data payload so monitoring clients can display it.

### Phase 4: Cleanup & Cancellation Handling

**Goal**: Properly clean up the forwarder on job completion or cancellation (Q8).

In the `finally` block of `executeJob()` (around line 416), flush remaining events then dispose:

```typescript
// In the finally block, before restoring the original branch:
forwarder.stop();
forwarderSubscription.dispose();
```

For cancellation specifically (Q8: "flush then stop"):
- When the executor is cancelled (via `executor.cancel()`), events emitted before cancellation are already in the queue.
- The `drain()` loop will process them before `stop()` is called in `finally`.
- This means events representing real work done before cancellation still reach the orchestrator.

### Phase 5: Tests

**Goal**: Verify event forwarding, mapping, progress calculation, error handling, and queue behavior.

Add a new `describe('event forwarding')` block to `job-handler.test.ts`:

| Test | What it verifies |
|------|-----------------|
| `should forward phase:start events to orchestrator` | Basic event mapping and publishEvent call |
| `should forward step:complete events with progress` | Progress calculation in event data |
| `should not forward execution:* events` | Filtering of execution-level events |
| `should not forward phase:error or step:error` | Dropped redundant error events (Q3) |
| `should map action:retry to action:error` | Correct type remapping |
| `should not fail job when event forwarding fails` | Non-blocking error handling |
| `should log first forwarding failure at warn, subsequent at debug` | Log throttling (Q5) |
| `should preserve event ordering` | Sequential queue guarantee (Q2) |
| `should calculate progress as completedSteps/totalSteps` | Equal weight per step (Q4) |
| `should stop forwarding after forwarder.stop()` | Cancellation cleanup (Q8) |

**Test approach**: Mock `client.publishEvent` to capture calls. Use a real `WorkflowExecutor` with a simple inline workflow (2 phases, 3 steps total) to emit real events. Verify the forwarded events match expectations.

### Phase 6: Type Export (Minor)

Add `ExecutionEventType` re-export to `types.ts` for type-safe mapping:

```typescript
// At the end of types.ts, or as a comment referencing the mapping
// (Optional — only if needed for external consumers)
```

Actually, since the mapping constant is internal to `job-handler.ts` and uses string literals, no type changes are needed in `types.ts`. The `ExecutionEvent` import in `job-handler.ts` from `@generacy-ai/workflow-engine` is sufficient.

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Skip `execution:*` events | Yes (Q1) | Avoid duplicating existing `updateJobStatus()` / `reportJobResult()` calls |
| Event ordering | Sequential async queue (Q2) | Monitoring clients reconstruct workflow state from event sequence |
| Drop `phase:error` / `step:error` | Yes (Q3) | Redundant — lifecycle completion events already carry failure status |
| Progress formula | `completedSteps / totalSteps * 100` (Q4) | Smoother, more honest progress that correlates with actual work |
| Log throttling | First warn, then debug (Q5) | Prevents log flooding during orchestrator outages |
| Batching | Deferred (Q6) | YAGNI — sequential queue provides natural buffering |
| Step count source | Closure capture from workflow definition (Q7) | Simple, deterministic, available before execution |
| Cancellation | Flush then stop (Q8) | Events for completed work still reach orchestrator |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Orchestrator outage causes event backlog | Queue discards on `stop()`; failures are non-blocking; no retry/backlog accumulation |
| High `step:output` volume | Events forwarded individually (no batching yet); if volume is an issue, batching can be added later (Q6) |
| Race between forwarder cleanup and final events | `forwarder.stop()` in `finally` block runs after `executor.execute()` completes; all events are already emitted |
| Event payload too large (e.g., large `step:output` data) | Orchestrator's `publishEvent` endpoint should enforce payload limits; not the worker's responsibility |
| Breaking existing phase-gate listener | Event forwarder is a **separate** `addEventListener` call; existing listener is untouched |

## Implementation Order

1. Add `EVENT_TYPE_MAP` constant and `createEventForwarder()` function to `job-handler.ts`
2. Wire up the forwarder in `executeJob()` after executor creation
3. Add cleanup in the `finally` block
4. Write tests
5. Manual verification with dev stack

## Estimated Scope

- ~120 lines of production code (all in `job-handler.ts`)
- ~200 lines of test code
- No new files, no new dependencies, no API changes
