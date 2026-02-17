# Implementation Plan: Worker — Forward Executor Events to Orchestrator via REST

**Branch**: `177-worker-forward-executor-events` | **Date**: 2026-02-17

## Summary

This plan implements event forwarding from the `WorkflowExecutor` to the orchestrator via REST. The `EventForwarder` class subscribes to all 15 executor event types in `JobHandler`, maps them to `JobEventType`, batches them for efficiency, publishes via `OrchestratorClient.publishEvent()`, and derives heartbeat progress from phase/step completion. A circuit breaker prevents cascading failures when the orchestrator is unreachable.

### Key Design Decisions (from Unanswered Clarifications)

Since the clarification questions are unanswered, this plan makes conservative default choices that can be adjusted:

| Question | Default Choice | Rationale |
|----------|---------------|-----------|
| Q1 (Event count) | Treat as 15 types | The code defines 15 `ExecutionEventType` values; handle all of them |
| Q2 (Batch endpoint) | **Client-side fan-out** (Option C) | No server changes needed; `publishEvents()` sends individual requests in parallel via `Promise.all` |
| Q3 (HeartbeatManager access) | **Progress callback** (Option B) | Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions` — keeps `HeartbeatManager` decoupled from `JobHandler` |
| Q4 (Conditional phases) | **Count all phases** (Option A) | Simpler; progress may jump but never decreases |
| Q5 (Error serialization) | **Message + stack** (Option B) | Include `{ error: message, stack }` for debugging |
| Q6 (Output size limits) | **Per-event limit** (Option B) | Truncate `step:output` data to 64KB with `[truncated]` marker |
| Q7 (Circuit breaker visibility) | **Worker logs only** (Option A) | Log at `warn` level when circuit opens/closes |
| Q8 (Event ordering) | **Strict FIFO ordering** (Option A) | Buffer is a simple array; events maintain emission order |
| Q9 (Flush vs circuit breaker) | **Override circuit breaker** (Option A) | Always attempt terminal events regardless of circuit state |
| Q10 (Flush on all paths) | **All paths via finally** (Option A) | Call `flush()` in `finally` block before `reportJobResult()` |
| Q11 (Duration tracking) | **Executor provides it** (Option A) | The executor already includes `PhaseResult`/`StepResult` (with `duration`) in `event.data` for `phase:complete`/`step:complete` — pass it through |
| Q12 (Batch endpoint fallback) | **Always individual** (Option C) | Send events individually; use `Promise.all` for client-side parallelism |

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Package**: `packages/generacy/src/orchestrator/`
- **Dependencies**: `@generacy-ai/workflow-engine` (provides `ExecutionEvent`, `ExecutionEventType`, `ExecutionEventListener`)
- **Runtime**: Node.js 20+ (native `fetch`, `AbortController`)
- **Testing**: Vitest

## Architecture Overview

```
┌──────────────────────────────────────────────────┐
│ JobHandler.executeJob()                          │
│                                                  │
│  ┌─────────────────┐    ┌──────────────────────┐ │
│  │ WorkflowExecutor │───▶│ EventForwarder       │ │
│  │ (event emitter)  │    │                      │ │
│  └─────────────────┘    │ ┌──────────────────┐ │ │
│                         │ │ Event Mapper     │ │ │
│                         │ │ ExecutionEvent → │ │ │
│                         │ │ JobEvent payload │ │ │
│                         │ └──────────────────┘ │ │
│                         │ ┌──────────────────┐ │ │
│                         │ │ Event Batcher    │ │ │
│                         │ │ 100ms buffer     │ │ │
│                         │ │ critical flush   │ │ │
│                         │ └──────────────────┘ │ │
│                         │ ┌──────────────────┐ │ │
│                         │ │ Circuit Breaker  │ │ │
│                         │ │ 10 fails → 30s   │ │ │
│                         │ └──────────────────┘ │ │
│                         │ ┌──────────────────┐ │ │
│                         │ │ Progress Tracker │ │ │
│                         │ │ phase/step based │ │ │
│                         │ └──────────────────┘ │ │
│                         └──────────────────────┘ │
│                                │                  │
│                    ┌───────────┴───────────┐     │
│                    ▼                       ▼     │
│  OrchestratorClient.publishEvent()   onProgress  │
│  (individual HTTP POST calls)        callback    │
└──────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: EventForwarder Core (New File)

**File**: `packages/generacy/src/orchestrator/event-forwarder.ts` (new)

Create the `EventForwarder` class with the following responsibilities:

#### 1.1 Event Mapping

Map all 15 `ExecutionEventType` values to `JobEventType` + `data` payload:

```typescript
interface MappedEvent {
  type: JobEventType;
  data: Record<string, unknown>;
  timestamp: number;
}
```

Mapping logic (implemented as a pure function `mapExecutorEvent`):

| ExecutionEventType | JobEventType | data construction |
|----|------|------|
| `execution:start` | `job:status` | `{ status: 'running' }` |
| `execution:complete` | `job:status` | `{ status: 'completed' }` |
| `execution:error` | `job:status` | `{ status: 'failed', error: message, stack? }` |
| `execution:cancel` | `job:status` | `{ status: 'cancelled' }` |
| `phase:start` | `phase:start` | `{ phaseName }` |
| `phase:complete` | `phase:complete` | `{ phaseName, duration }` |
| `phase:error` | `action:error` | `{ phaseName, error: message, stack? }` |
| `step:start` | `step:start` | `{ phaseName, stepName }` |
| `step:complete` | `step:complete` | `{ phaseName, stepName, duration }` |
| `step:error` | `action:error` | `{ phaseName, stepName, error: message, stack? }` |
| `step:output` | `step:output` | `{ phaseName, stepName, output }` (truncated to 64KB) |
| `action:start` | `log:append` | `{ phaseName, stepName, message }` |
| `action:complete` | `log:append` | `{ phaseName, stepName, message }` |
| `action:error` | `action:error` | `{ phaseName, stepName, error: message, stack? }` |
| `action:retry` | `log:append` | `{ phaseName, stepName, attempt, maxAttempts, message }` |

Error serialization: extract `error.message` and `error.stack` from `event.data` or `event.message`. If `event.data` contains a result object with an `error` string field, use that.

Duration extraction: for `phase:complete` and `step:complete`, the executor sets `event.data` to the `PhaseResult`/`StepResult` which includes `duration`. Extract `data.duration` directly.

Output truncation: for `step:output`, truncate `event.message` (the stdout content) to 64KB, appending `\n[truncated]` if exceeded.

#### 1.2 Event Batching

Internal buffer (array) collects mapped events. A `setTimeout` of 100ms triggers flush. Critical event types flush immediately:

```typescript
const CRITICAL_EVENTS: Set<JobEventType> = new Set([
  'phase:start', 'phase:complete', 'action:error',
  'step:complete', 'job:status',
]);
```

Note: `step:error` maps to `action:error` (critical). `execution:*` maps to `job:status` (critical). `phase:error` maps to `action:error` (critical).

On flush: send each event individually via `client.publishEvent()` in parallel (`Promise.all`). Errors are caught per-event and fed to the circuit breaker.

#### 1.3 Circuit Breaker

State machine: `CLOSED` → (10 consecutive failures) → `OPEN` → (30s timer) → `HALF_OPEN` → (1 success) → `CLOSED` / (1 failure) → `OPEN`.

When `OPEN`: events are silently dropped (logged at `debug`). When `HALF_OPEN`: allow one event through to test.

Exception: terminal events (`execution:complete`, `execution:error`, `execution:cancel`) always attempt delivery regardless of circuit state (Q9 default).

#### 1.4 Progress Tracking

Track state:
- `completedPhases: number` — incremented on `phase:complete` (including skipped phases if emitted)
- `totalPhases: number` — from workflow definition
- `completedStepsInCurrentPhase: number` — reset on each `phase:start`
- `totalStepsInCurrentPhase: number` — from `stepsPerPhase` map

Formula:
```
progress = ((completedPhases + completedStepsInCurrentPhase / totalStepsInCurrentPhase) / totalPhases) * 100
```

Clamped to `[0, 100]`. Monotonically increasing (only update if new value > current). Reaches exactly 100 only on `execution:complete`.

Call `onProgress(jobId, progress)` whenever progress changes.

#### 1.5 Class Interface

```typescript
export interface EventForwarderOptions {
  client: OrchestratorClient;
  jobId: string;
  logger: Logger;
  totalPhases: number;
  stepsPerPhase: Map<string, number>;
  onProgress?: (progress: number) => void;
  flushIntervalMs?: number;        // default: 100
  circuitBreakerThreshold?: number; // default: 10
  circuitBreakerResetMs?: number;   // default: 30_000
  maxOutputBytes?: number;          // default: 65536 (64KB)
}

export class EventForwarder {
  constructor(options: EventForwarderOptions);

  /** Synchronous — called from executor event listener. Buffers the event. */
  handleEvent(event: ExecutionEvent): void;

  /** Async — flush all buffered events. Await before reportJobResult(). */
  flush(): Promise<void>;

  /** Clean up timers. */
  dispose(): void;
}
```

### Phase 2: JobHandler Integration

**File**: `packages/generacy/src/orchestrator/job-handler.ts` (modify)

#### 2.1 Add `onProgress` callback to `JobHandlerOptions`

```typescript
export interface JobHandlerOptions {
  // ... existing fields ...

  /** Callback when job progress updates */
  onProgress?: (jobId: string, progress: number) => void;
}
```

Store as `this.onProgress` in the constructor.

#### 2.2 Wire EventForwarder in `executeJob()`

After creating the executor (line 229) and before calling `executor.execute()` (line 234), insert:

```typescript
// Create event forwarder
const forwarder = new EventForwarder({
  client: this.client,
  jobId: job.id,
  logger: this.logger,
  totalPhases: workflow.phases.length,
  stepsPerPhase: new Map(workflow.phases.map(p => [p.name, p.steps.length])),
  onProgress: this.onProgress
    ? (progress) => this.onProgress!(job.id, progress)
    : undefined,
});

// Subscribe to executor events
const subscription = executor.addEventListener((event) => {
  forwarder.handleEvent(event);
});
```

#### 2.3 Flush and dispose in all exit paths

Wrap the try/catch to include flush:

```typescript
try {
  const result = await executor.execute(workflow, execOptions, job.inputs);
  await forwarder.flush();
  // ... build job result, report ...
} catch (error) {
  await forwarder.flush();
  // ... existing error handling ...
} finally {
  subscription.dispose();
  forwarder.dispose();
  // ... existing finally block (branch restore, cleanup) ...
}
```

The `forwarder.flush()` call is in both success and error paths to ensure terminal events are delivered before `reportJobResult()`. The `dispose()` in `finally` cleans up timers.

#### 2.4 Import changes

Add imports:
```typescript
import { EventForwarder } from './event-forwarder.js';
import type { ExecutionEvent } from '@generacy-ai/workflow-engine';
```

### Phase 3: OrchestratorClient — Batch Helper

**File**: `packages/generacy/src/orchestrator/client.ts` (modify)

Add a convenience method for publishing multiple events:

```typescript
/**
 * Publish multiple events for a job in parallel.
 * Each event is sent as an individual HTTP request.
 */
async publishEvents(
  jobId: string,
  events: Array<{ type: JobEventType; data: Record<string, unknown>; timestamp?: number }>,
): Promise<Array<{ eventId: string } | { error: string }>> {
  const results = await Promise.allSettled(
    events.map(event => this.publishEvent(jobId, event))
  );
  return results.map(r =>
    r.status === 'fulfilled' ? r.value : { error: r.reason?.message ?? 'Unknown error' }
  );
}
```

This method is used by `EventForwarder.flush()` to send batched events. Each event is still an individual HTTP call (no server-side changes required), but they execute concurrently.

### Phase 4: Worker Bootstrap Wiring

**File**: `packages/generacy/src/cli/commands/worker.ts` (modify)

Add the `onProgress` callback when constructing `JobHandler`:

```typescript
const jobHandler = new JobHandler({
  // ... existing options ...
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  },
});
```

This bridges `EventForwarder` → `JobHandler.onProgress` → `HeartbeatManager.setCurrentJob(jobId, progress)` without `JobHandler` needing a direct reference to `HeartbeatManager`.

### Phase 5: Module Exports

**File**: `packages/generacy/src/orchestrator/index.ts` (modify)

Add exports for the new class:

```typescript
export { EventForwarder } from './event-forwarder.js';
export type { EventForwarderOptions } from './event-forwarder.js';
```

### Phase 6: Tests

**File**: `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts` (new)

Test cases:

1. **Event mapping**: Each of the 15 executor event types maps to the correct `JobEventType` and `data` shape
2. **Batching**: Events buffered within 100ms are sent together; critical events flush immediately
3. **Circuit breaker**: After 10 consecutive failures, events are dropped; after 30s recovery, forwarding resumes
4. **Progress calculation**: Verify monotonic progress, step-level granularity, reaches 100 only on completion
5. **Output truncation**: `step:output` events exceeding 64KB are truncated
6. **Error isolation**: `publishEvent` failures don't propagate; workflow execution continues
7. **Terminal event override**: Terminal events bypass circuit breaker
8. **Flush before result**: Flush completes before `reportJobResult()` is called
9. **Dispose**: Timers are cleaned up; no lingering intervals

Test approach: Mock `OrchestratorClient` (inject mock), use real `ExecutionEventEmitter` to drive events. Use `vi.useFakeTimers()` for batching and circuit breaker timing.

**File**: `packages/generacy/src/orchestrator/__tests__/job-handler-events.test.ts` (new)

Integration test: Create a `JobHandler` with a mock client, execute a simple inline workflow, verify that events are published to the client and progress callback is invoked.

## Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | **Create** | EventForwarder class with mapping, batching, circuit breaker, progress |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Add `onProgress` to options; wire EventForwarder in `executeJob()` |
| `packages/generacy/src/orchestrator/client.ts` | **Modify** | Add `publishEvents()` batch helper method |
| `packages/generacy/src/cli/commands/worker.ts` | **Modify** | Pass `onProgress` callback to bridge heartbeat progress |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Export `EventForwarder` and `EventForwarderOptions` |
| `packages/generacy/src/orchestrator/__tests__/event-forwarder.test.ts` | **Create** | Unit tests for EventForwarder |
| `packages/generacy/src/orchestrator/__tests__/job-handler-events.test.ts` | **Create** | Integration tests for event forwarding in JobHandler |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Event listener blocks executor thread | `handleEvent()` is fully synchronous — only pushes to buffer and (optionally) schedules a microtask for flush. No `await` in the listener path. |
| High `step:output` volume causes memory pressure | 64KB per-event truncation. Buffer is flushed every 100ms. Circuit breaker drops events under sustained failure. |
| Duplicate `job:status` events (from both `updateJobStatus()` and `EventForwarder`) | Acceptable — the orchestrator's event bus assigns unique monotonic IDs. Consumers can deduplicate by status value if needed. Alternatively, `execution:start` mapping can be skipped since `updateJobStatus('running')` already fires a `job:status` event. |
| `flush()` fails on terminal events | Terminal events override the circuit breaker. If the HTTP call itself fails, it's logged and the `reportJobResult()` call proceeds — the orchestrator learns the job status from the result endpoint. |
| Progress jumps when phases are skipped | Progress is clamped to [0, 100] and monotonically increasing. Jumps are cosmetic and acceptable for v1. |

## Task Dependency Graph

```
Phase 1 (EventForwarder)
  ├── Phase 2 (JobHandler integration) ← depends on Phase 1
  ├── Phase 3 (Client batch helper) ← depends on Phase 1
  └── Phase 4 (Worker bootstrap wiring) ← depends on Phase 2
Phase 5 (Module exports) ← depends on Phase 1
Phase 6 (Tests) ← depends on Phases 1-5
```

Phases 2, 3, and 5 can be done in parallel once Phase 1 is complete. Phase 4 depends on Phase 2. Phase 6 depends on all prior phases.

---

*Generated by speckit*
