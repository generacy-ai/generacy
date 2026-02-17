# Research: Worker Event Forwarding

## Executor Event Emission Analysis

### Event Lifecycle

The `WorkflowExecutor` emits events at these points in the execution flow:

```
execute()
├── execution:start (line 157)
├── for each phase:
│   ├── executePhase()
│   │   ├── phase:start (line 267) — ALWAYS emitted, even for skipped phases
│   │   ├── [condition check] → skipped phases return early (line 280) — NO completion event
│   │   ├── for each step:
│   │   │   ├── executeStep()
│   │   │   │   ├── step:start (line 382) — ALWAYS emitted, even for skipped steps
│   │   │   │   ├── [condition check] → skipped steps return early (line 396) — NO completion event
│   │   │   │   ├── executeWithActionHandler()
│   │   │   │   │   ├── action:start (line 504)
│   │   │   │   │   ├── action:retry (line 512) — on retry callback
│   │   │   │   │   └── action:complete OR action:error (line 532)
│   │   │   │   ├── step:output (line 439) — only if actionResult.stdout exists
│   │   │   │   └── step:complete OR step:error (line 467) — finalization block
│   │   └── phase:complete OR phase:error (line 347) — finalization block
│   │       ⚠️ Also phase:error in catch block (line 331) — DUPLICATE for failed phases
└── execution:complete OR execution:error (line 230)
```

### Critical Findings

#### 1. Skipped Phases Don't Emit Completion Events

When a phase's condition evaluates to false (`executePhase()` line 272-282):
- `phase:start` is emitted **before** condition evaluation
- Phase returns early with `status: 'skipped'`
- The finalization block (line 337-355) is **never reached**
- No `phase:complete` event is emitted for skipped phases

**Impact on progress**: Progress tracking based on `phase:complete` count will not account for skipped phases. Total progress won't reach 100% from phase events alone.

**Mitigation**: Cap progress at 99% during execution, set to 100% only after `executor.execute()` returns.

#### 2. Duplicate phase:error Emission

When a phase fails with an exception (catch block at line 329-335):
1. `phase:error` emitted in the catch block (line 331)
2. `result.status` set to `'failed'`
3. Finalization block (line 347-348) checks `result.status === 'completed'` → false
4. `phase:error` emitted **again** in the finalization block (line 347)

**Impact**: Two `phase:error` events for the same phase sent to orchestrator.

**Mitigation**: Track forwarded phase errors in a `Set<string>` and skip duplicates.

#### 3. Step Skipping Behavior

Same pattern as phases: `step:start` is emitted before condition check, but skipped steps return early (line 396) without reaching the finalization block (line 466-476). No `step:complete` emitted for skipped steps.

#### 4. Event Data Payloads

| Event | `event.data` | Size |
|---|---|---|
| `phase:complete` | Full `PhaseResult` (nested `stepResults[]`) | Large |
| `phase:error` | Full `PhaseResult` (in finalization) or `undefined` (in catch) | Variable |
| `step:complete` | Full `StepResult` | Medium |
| `step:error` | Full `StepResult` | Medium |
| `action:complete` | `{ attempts, totalDuration }` | Small |
| `action:error` | `{ attempts, totalDuration }` | Small |
| `action:retry` | `RetryState` object | Small |
| All others | `undefined` | None |

**Decision**: Extract only `duration` from completion event data. Do not spread full result objects.

## HeartbeatManager API

The `HeartbeatManager.setCurrentJob(jobId, progress?)` method accepts an optional progress parameter (0-100). It's already called by `worker.ts` in the `onJobStart` and `onJobComplete` callbacks:

```typescript
onJobStart: (job) => {
  heartbeatManager.setStatus('busy');
  heartbeatManager.setCurrentJob(job.id);      // progress = undefined
},
onJobComplete: (job, result) => {
  heartbeatManager.setStatus('idle');
  heartbeatManager.setCurrentJob(undefined);    // clears job + progress
},
```

To update progress mid-job, we need to call `heartbeatManager.setCurrentJob(jobId, progress)` with the current job ID and new progress value. This is cleanest via a new `onProgress` callback.

## publishEvent API

```typescript
// client.ts line 178-183
async publishEvent(
  jobId: string,
  event: { type: JobEventType; data: Record<string, unknown>; timestamp?: number },
): Promise<{ eventId: string }>
```

- Endpoint: `POST /api/jobs/${jobId}/events`
- Returns `{ eventId: string }` — monotonic counter per job
- Throws `OrchestratorClientError` on failure (non-OK HTTP response)
- Uses `this.request()` which applies timeout and auth headers

## Orchestrator Event Type Union

```typescript
// types.ts line 204-212
type JobEventType =
  | 'job:status'
  | 'phase:start' | 'phase:complete'
  | 'step:start'  | 'step:complete' | 'step:output'
  | 'action:error'
  | 'log:append';
```

Unmapped executor events (`phase:error`, `step:error`, `action:start`, `action:complete`, `action:retry`) must map to `log:append` since they have no direct `JobEventType` equivalent.

## Existing Callback Pattern

`JobHandlerOptions` uses callbacks for lifecycle events:

```typescript
onJobStart?: (job: Job) => void;
onJobComplete?: (job: Job, result: JobResult) => void;
onError?: (error: Error, job?: Job) => void;
```

Adding `onProgress?: (jobId: string, progress: number) => void` follows this same pattern. The `worker.ts` wiring code handles the bridging between callback and `HeartbeatManager`.
