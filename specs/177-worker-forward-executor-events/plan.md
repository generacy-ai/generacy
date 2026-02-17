# Implementation Plan: Worker — Forward Executor Events to Orchestrator via REST

## Summary

Create an `EventForwarder` helper function that subscribes to `WorkflowExecutor` events, maps them to `JobEventType`, and forwards them to the orchestrator via `OrchestratorClient.publishEvent()`. The forwarder uses fire-and-forget semantics with error logging, computes progress from the workflow definition, and exposes progress via a callback. All logic is extracted into a testable standalone module, wired into `JobHandler.executeJob()`.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Package**: `packages/generacy` (worker/orchestrator client)
- **Test framework**: Vitest (`pnpm test` in package)
- **Key dependency**: `@generacy-ai/workflow-engine` — provides `WorkflowExecutor`, `ExecutionEvent`, `ExecutionEventType`

## Architecture Overview

```
WorkflowExecutor
  │ emits ExecutionEvent (sync)
  ▼
EventForwarder (listener)
  ├── Maps ExecutionEventType → JobEventType
  ├── Builds data payload (Record<string, unknown>)
  ├── Computes duration (tracks start timestamps)
  ├── Computes progress (phases/steps completed vs total)
  ├── Calls onProgress callback (for HeartbeatManager)
  └── Fires publishEvent() with .catch() (fire-and-forget)

OrchestratorClient.publishEvent()
  │ POST /api/jobs/:jobId/events
  ▼
Orchestrator Server (existing)
  └── EventBus → SSE subscribers
```

## Clarification Decisions

| Q# | Question | Decision | Rationale |
|----|----------|----------|-----------|
| Q1 | Non-object event data handling | **Option C**: Spread valid object data only | All executor data is either `undefined` or a plain object in practice. Safe spread with fallback to `{}`. |
| Q2 | Phase/step count source | **Option A**: Derive from workflow definition | `workflow.phases.length` and `phase.steps.length` are available at execution start. Simpler and more accurate than event counting. |
| Q3 | Skipped phase progress | **Option B**: Use definition totals, jump on completion | Use definition totals as denominator. Force progress to 100% on `execution:complete`. Accept potential jumps when phases are skipped — this is acceptable UX. |
| Q4 | Batching | **Option A**: Defer batching entirely | Ship individual event forwarding. The spec marks FR-006 as P2 and optional for initial implementation. Batching adds significant complexity (timers, flush logic) with no current evidence it's needed. |
| Q5 | Terminal event forwarding | **Option B**: Forward `execution:complete/error/cancel` as `log:append` | Avoids triggering `eventBus.closeJobSubscribers()` race condition with `reportJobResult()`. Forward `execution:start` as `job:status` (safe). Terminal execution events become informational log entries. |
| Q6 | Error logging strategy | **Option B**: Log with rate limiting | Log the first failure, suppress subsequent failures for the same job, log a summary at dispose time. Prevents log flooding during sustained orchestrator outages. |
| Q7 | Code organization | **Option C**: Extract to standalone function module | `createEventForwarder()` returns `{ listener, dispose }`. Lighter than a class, fully testable, easy to wire into `executeJob()`. |
| Q8 | `phase:error` mapping | **Option A**: Map to `phase:complete` with error flag | Include `{ status: 'error', error: ... }` in data. Phase completion encompasses both success and failure outcomes. Clients distinguish via the `status` field. |
| Q9 | Async fire-and-forget | **Option A**: Void the promise with `.catch()` | `client.publishEvent(...).catch(err => ...)` — simplest pattern, handles rejections, doesn't block the synchronous listener. |
| Q10 | Duration calculation | **Option A**: Track start timestamps in a Map | Store `{ [key]: startTimestamp }` on `:start` events, compute `duration = completeTimestamp - startTimestamp` on `:complete` events. Explicit and reliable. |

## Implementation Phases

### Phase 1: Create EventForwarder module

**File**: `packages/generacy/src/orchestrator/event-forwarder.ts` (new)

Create a `createEventForwarder()` function:

```typescript
import type { ExecutionEvent, ExecutionEventType } from '@generacy-ai/workflow-engine';
import type { OrchestratorClient } from './client.js';
import type { JobEventType } from './types.js';
import type { Logger } from '@generacy-ai/workflow-engine';

interface EventForwarderOptions {
  client: OrchestratorClient;
  jobId: string;
  logger: Logger;
  totalPhases: number;
  stepsPerPhase: number[];
  onProgress?: (progress: number) => void;
}

interface EventForwarderResult {
  listener: (event: ExecutionEvent) => void;
  dispose: () => void;
}

export function createEventForwarder(options: EventForwarderOptions): EventForwarderResult;
```

#### Event Type Mapping

```typescript
const EVENT_TYPE_MAP: Record<ExecutionEventType, JobEventType> = {
  'execution:start':    'job:status',
  'execution:complete': 'log:append',    // Avoid terminal side effects (Q5)
  'execution:error':    'log:append',    // Avoid terminal side effects (Q5)
  'execution:cancel':   'log:append',    // Avoid terminal side effects (Q5)
  'phase:start':        'phase:start',
  'phase:complete':     'phase:complete',
  'phase:error':        'phase:complete', // With status:'error' in data (Q8)
  'step:start':         'step:start',
  'step:complete':      'step:complete',
  'step:error':         'action:error',
  'step:output':        'step:output',
  'action:start':       'log:append',
  'action:complete':    'log:append',
  'action:error':       'action:error',
  'action:retry':       'log:append',
};
```

#### Data Payload Construction

For each event, build `Record<string, unknown>`:
```typescript
{
  workflowName: event.workflowName,
  phaseName: event.phaseName,         // when present
  stepName: event.stepName,           // when present
  message: event.message,             // when present
  duration: computedDuration,         // for :complete events
  status: 'error',                    // for :error events mapped to :complete
  error: extractError(event),         // for :error events
  ...(isPlainObject(event.data) ? event.data : {}),
}
```

Remove `undefined` values before sending.

#### Duration Tracking

```typescript
const startTimes = new Map<string, number>();

// On :start events, store: startTimes.set(`phase:${phaseName}`, timestamp)
// On :complete events, compute: duration = timestamp - startTimes.get(key)
// Delete entry after use
```

Keys: `phase:${phaseName}`, `step:${phaseName}:${stepName}`, `action:${phaseName}:${stepName}`

#### Progress Calculation

```typescript
let completedPhases = 0;
let completedStepsInCurrentPhase = 0;
let currentPhaseIndex = -1;

// On phase:start: find phase index, reset step counter
// On step:complete: increment step counter, recalculate
// On phase:complete: increment phase counter, recalculate
// On execution:complete: force progress to 100

const totalSteps = stepsPerPhase.reduce((a, b) => a + b, 0);
// Progress as weighted average:
// effectiveCompleted = completedPhases + (completedStepsInCurrentPhase / stepsPerPhase[currentPhaseIndex])
// progress = Math.round((effectiveCompleted / totalPhases) * 100)
```

#### Error Logging (Rate-Limited)

```typescript
let failureCount = 0;
let firstFailureLogged = false;

// On publishEvent error:
failureCount++;
if (!firstFailureLogged) {
  logger.warn(`Event forwarding failed for job ${jobId}: ${error.message}`);
  firstFailureLogged = true;
}

// On dispose:
if (failureCount > 0) {
  logger.warn(`Event forwarding: ${failureCount} failures for job ${jobId}`);
}
```

#### Fire-and-Forget Pattern

```typescript
const listener = (event: ExecutionEvent) => {
  const jobEventType = EVENT_TYPE_MAP[event.type];
  const data = buildPayload(event);

  client.publishEvent(jobId, {
    type: jobEventType,
    data,
    timestamp: event.timestamp,
  }).catch((err) => {
    // rate-limited logging
  });

  // Update progress synchronously (for heartbeat callback)
  updateProgress(event);
};
```

### Phase 2: Wire into JobHandler

**File**: `packages/generacy/src/orchestrator/job-handler.ts` (modify)

#### Changes to `JobHandlerOptions`

Add optional `onProgress` callback:
```typescript
export interface JobHandlerOptions {
  // ... existing fields ...

  /** Callback for job progress updates (0-100) */
  onProgress?: (jobId: string, progress: number) => void;
}
```

#### Changes to `executeJob()`

After creating the executor (line 219) and before calling `executor.execute()` (line 222):

```typescript
// Attach event forwarder
const forwarder = createEventForwarder({
  client: this.client,
  jobId: job.id,
  logger: this.logger,
  totalPhases: workflow.phases.length,
  stepsPerPhase: workflow.phases.map(p => p.steps.length),
  onProgress: (progress) => this.onProgress?.(job.id, progress),
});

const subscription = executor.addEventListener(forwarder.listener);
```

In the `finally` block (after line 264):
```typescript
// Clean up event forwarder
subscription.dispose();
forwarder.dispose();
```

#### New imports

```typescript
import { createEventForwarder } from './event-forwarder.js';
```

Store and invoke the new callback:
```typescript
private readonly onProgress?: (jobId: string, progress: number) => void;

// In constructor:
this.onProgress = options.onProgress;
```

### Phase 3: Wire progress to HeartbeatManager

**File**: `packages/generacy/src/cli/commands/worker.ts` (modify)

In the `JobHandler` options, add the `onProgress` callback:

```typescript
const jobHandler = new JobHandler({
  // ... existing options ...
  onProgress: (jobId, progress) => {
    heartbeatManager.setCurrentJob(jobId, progress);
  },
});
```

**File**: `packages/generacy/src/cli/commands/agent.ts` (modify)

Same change for the agent command.

### Phase 4: Export new module

**File**: `packages/generacy/src/orchestrator/index.ts` (modify)

Add export:
```typescript
export { createEventForwarder } from './event-forwarder.js';
export type { EventForwarderOptions, EventForwarderResult } from './event-forwarder.js';
```

### Phase 5: Tests

**File**: `packages/generacy/src/__tests__/event-forwarder.test.ts` (new)

Test cases:

1. **Event type mapping**: Verify all 15 `ExecutionEventType` values map to the correct `JobEventType`
2. **Data payload construction**: Verify `workflowName`, `phaseName`, `stepName`, `message` are included; verify `event.data` is spread when it's a plain object
3. **Duration calculation**: Emit `phase:start` then `phase:complete`; verify `duration` is computed correctly
4. **Progress calculation**: Emit events for a 2-phase, 3-step workflow; verify `onProgress` is called with correct percentages
5. **Progress reaches 100 on completion**: Emit `execution:complete`; verify progress is 100
6. **Fire-and-forget error handling**: Mock `publishEvent` to throw; verify no exception propagates
7. **Rate-limited error logging**: Mock `publishEvent` to throw 10 times; verify logger.warn is called twice (first failure + summary)
8. **Dispose cleanup**: Verify dispose logs summary and subsequent events are not forwarded
9. **Non-object data handling**: Emit event with `data: undefined`; verify payload has no extra data spread
10. **phase:error maps to phase:complete with error flag**: Verify data includes `status: 'error'`
11. **Terminal events map to log:append**: Verify `execution:complete/error/cancel` become `log:append`

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/event-forwarder.ts` | **Create** | New module: `createEventForwarder()` function with event mapping, payload construction, duration tracking, progress calculation, fire-and-forget forwarding |
| `packages/generacy/src/orchestrator/job-handler.ts` | **Modify** | Add `onProgress` callback to options; attach event forwarder before execution; dispose after execution |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Export `createEventForwarder` and related types |
| `packages/generacy/src/cli/commands/worker.ts` | **Modify** | Wire `onProgress` callback to `heartbeatManager.setCurrentJob()` |
| `packages/generacy/src/cli/commands/agent.ts` | **Modify** | Wire `onProgress` callback to `heartbeatManager.setCurrentJob()` |
| `packages/generacy/src/__tests__/event-forwarder.test.ts` | **Create** | Unit tests for event forwarder |

## Files NOT Changed

| File | Reason |
|------|--------|
| `packages/generacy/src/orchestrator/client.ts` | `publishEvent()` already exists with correct signature |
| `packages/generacy/src/orchestrator/server.ts` | `POST /api/jobs/:jobId/events` already accepts all 8 `JobEventType` values |
| `packages/generacy/src/orchestrator/types.ts` | No type changes needed; `ExecutionEvent`/`ExecutionEventType` already exported from workflow-engine |
| `packages/generacy/src/orchestrator/heartbeat.ts` | `setCurrentJob(jobId, progress)` already accepts progress parameter |
| `packages/workflow-engine/src/**` | No changes to the workflow-engine package (out of scope) |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Terminal event race condition (SSE closes before result reported) | Map `execution:complete/error/cancel` to `log:append` instead of `job:status` |
| Log flooding during orchestrator outage | Rate-limited logging: first failure + summary at dispose |
| Memory leak from unreleased listener | `subscription.dispose()` + `forwarder.dispose()` in `finally` block |
| Event data type mismatch (`unknown` vs `Record<string, unknown>`) | Safe spread with `isPlainObject()` guard; undefined values stripped from payload |
| Progress never reaches 100% due to skipped phases | Force progress to 100 on `execution:complete` event |
| Unhandled promise rejections from fire-and-forget | Every `publishEvent()` call has explicit `.catch()` handler |
