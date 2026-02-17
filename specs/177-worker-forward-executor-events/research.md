# Research: Worker Event Forwarding

## Architecture Analysis

### Current Worker Wiring (worker.ts command)

The `heartbeatManager` and `jobHandler` are created separately in the worker command (`cli/commands/worker.ts`). They interact only via callbacks:

```typescript
const jobHandler = new JobHandler({
  onJobStart: (job) => {
    heartbeatManager.setStatus('busy');
    heartbeatManager.setCurrentJob(job.id);
  },
  onJobComplete: (job, result) => {
    heartbeatManager.setStatus('idle');
    heartbeatManager.setCurrentJob(undefined);
  },
});
```

`HeartbeatManager` is **not** passed into `JobHandler`. This means progress updates need to either:
1. Be handled via a new `onProgress` callback on `JobHandlerOptions`, or
2. Pass `heartbeatManager` directly into `JobHandler`

**Decision**: Use a callback approach (`onProgress`) to avoid tight coupling between the two classes.

### ExecutionEventEmitter Characteristics

- `emit()` is **synchronous** — listeners are called inline during workflow execution
- Listener errors are caught with try/catch, logged to `console.error`, but do not propagate
- `addEventListener()` returns `{ dispose: () => void }` for cleanup
- The listener type is `(event: ExecutionEvent) => void` — synchronous signature

### Event Data Shape

`ExecutionEvent.data` is typed as `unknown`. In practice:
- `execution:complete`/`execution:error`: data is `ExecutionResult` (object)
- `phase:complete`/`phase:error`: data is `PhaseResult` (object)
- `step:complete`/`step:error`: data is `StepResult` (object)
- `action:complete`/`action:error`: data is `{ attempts, totalDuration }` (object)
- `action:retry`: data is `RetryState` (object)
- Start events: data is `undefined`
- `step:output`: data is `undefined` (stdout is in `message`)

All non-undefined data values are plain objects, so safe coercion with `typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) ? event.data : {}` is the right approach.

### Terminal Event Race Condition (Q5)

The server has terminal event handling in `publishEvent()`:
```typescript
if (body.type === 'job:status' &&
    terminalStatuses.includes(body.data.status)) {
  eventBus.closeJobSubscribers(jobId);
  eventBus.scheduleCleanup(jobId);
}
```

If we forward `execution:complete` as `job:status` with `status: 'completed'` in data, it triggers SSE closure **before** `reportJobResult()` is called. This is a real race condition.

**Decision**: Forward `execution:start` as `job:status` (safe), but map `execution:complete/error/cancel` to `log:append` to avoid triggering terminal side effects. The `reportJobResult()` path already handles terminal status transitions.

### Progress Calculation from Workflow Definition

`prepareWorkflow()` returns `ExecutableWorkflow` which has `phases: PhaseDefinition[]`. Each phase has `steps: StepDefinition[]`. Phases and steps can have optional `condition` fields.

Since conditions are evaluated at runtime by the executor (and we don't have access to the evaluation), the safest approach is:
1. Use definition totals for the denominator
2. Force progress to 100% on `execution:complete`
3. Accept potential jumps when phases are skipped

### No Existing Tests for JobHandler

There are no unit tests for `JobHandler` currently. The test file at `packages/generacy/src/__tests__/cli.test.ts` only tests CLI config and basic `HeartbeatManager` construction. Tests for the new `EventForwarder` should be added as a new test file.

### Available Imports from workflow-engine

The following types are already exported from `@generacy-ai/workflow-engine`:
- `ExecutionEventType`
- `ExecutionEvent`
- `ExecutionEventListener`
- `ExecutionEventEmitter`

No re-exports needed in `types.ts`.
