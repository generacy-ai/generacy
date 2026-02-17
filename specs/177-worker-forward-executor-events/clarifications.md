# Clarification Questions

## Status: Pending

## Questions

### Q1: Event Data Type Coercion
**Context**: The `ExecutionEvent.data` field is typed as `unknown` in the workflow-engine package, but `OrchestratorClient.publishEvent()` requires `data: Record<string, unknown>`. The server also validates that `body.data` is a non-null, non-array object. If an executor event has `data` set to a primitive, an array, or `undefined`, the forwarding code needs to handle this mismatch.
**Question**: How should the event forwarder handle `ExecutionEvent.data` values that are not plain objects (e.g., `undefined`, a string, an array)?
**Options**:
- A) Wrap non-object data: If `data` is a primitive, wrap it as `{ value: data }`; if undefined, use `{}`; if array, wrap as `{ items: data }`.
- B) Always use an empty object for non-object data: Non-object `data` values are discarded and replaced with `{}`, relying on the other top-level fields (phaseName, stepName, message) to carry context.
- C) Spread valid object data only: Use `...(typeof event.data === 'object' && event.data !== null && !Array.isArray(event.data) ? event.data : {})` to safely merge whatever is valid, ignoring the rest.
**Answer**:

---

### Q2: Phase/Step Index Availability in Events
**Context**: The spec's progress calculation (FR-007) requires knowing completed vs. total phases and steps. The executor internally tracks `phaseIndex`/`totalPhases` and `stepIndex`/`totalSteps` but does **not** include these values in emitted `ExecutionEvent` objects. The forwarder would need to either (a) independently track counts by listening to start/complete events, or (b) derive totals from the workflow definition available in `executeJob()`.
**Question**: Should the event forwarder derive phase/step counts from the workflow definition loaded in `executeJob()`, or should it maintain its own counter by tracking `phase:start`/`step:start` events?
**Options**:
- A) Derive from workflow definition: Use `workflow.phases.length` and `phase.steps.length` to know totals upfront, and increment counters on `:complete` events. This is simpler and more accurate.
- B) Track from events only: Count `phase:start` events to infer progress. This avoids coupling to the workflow definition shape but may be less accurate (e.g., conditional phases may be skipped).
- C) Hybrid approach: Use the workflow definition for totals, but adjust for skipped phases/steps by only counting those that actually emit `:start` events.
**Answer**:

---

### Q3: Conditional Phases and Progress Calculation
**Context**: `PhaseDefinition` and `StepDefinition` both have optional `condition` fields. Phases or steps with unsatisfied conditions may be skipped entirely (no events emitted). The spec's progress formula `completedPhases / totalPhases * 100` uses the total from the workflow definition, but if phases are skipped, progress would never reach 100% based on `:complete` events alone.
**Question**: How should progress be calculated when phases or steps are conditionally skipped?
**Options**:
- A) Count only executed phases: Track which phases actually emit `phase:start`, use that as the effective total. Progress reaches 100% on `execution:complete`.
- B) Use definition totals, jump on completion: Use `workflow.phases.length` as the total, accept that progress may jump (e.g., 66% -> 100%) when skipped phases are not counted. Force progress to 100% on `execution:complete`.
- C) Use definition totals, mark skipped as complete: Count skipped phases as completed for progress purposes — if a phase never starts, treat it as done when the next phase starts.
**Answer**:

---

### Q4: Batching Implementation in Initial Version
**Context**: FR-006 describes a batching strategy with a 100ms window and immediate flush for milestone events. However, the spec also states "For the initial implementation, batching is optional." Batching adds meaningful complexity (timers, flush logic, batch payload format) and the orchestrator's `publishEvent()` currently accepts a single event, not an array.
**Question**: Should batching (FR-006) be implemented in the initial version, or deferred to a follow-up?
**Options**:
- A) Defer batching entirely: Ship individual event forwarding first. Add batching only if performance testing reveals it's needed. This keeps the initial implementation simple.
- B) Implement basic batching: Add a 100ms debounce window with immediate flush for milestone events. Requires a new batch endpoint or sequential single-event POSTs within the flush.
- C) Implement client-side queuing only: Buffer events in memory and send them sequentially (one POST per event) but from a dedicated async queue rather than inline. This gives non-blocking behavior without needing a batch endpoint.
**Answer**:

---

### Q5: Terminal Event Side Effects on Server
**Context**: The orchestrator server has special handling for `job:status` events: if `data.status` is `completed`, `failed`, or `cancelled`, it calls `eventBus.closeJobSubscribers()` and `eventBus.scheduleCleanup()`. The spec maps `execution:complete` to `job:status`. If the event forwarder sends a `job:status` event with `status: 'completed'` in the data, it will trigger SSE stream closure — but `JobHandler` also separately calls `client.reportJobResult()` which updates job status. This could cause a race condition where SSE closes before the final result is reported.
**Question**: Should execution-level events (`execution:complete`, `execution:error`, `execution:cancel`) be forwarded as `job:status` events, given that `JobHandler.reportJobResult()` already handles terminal status transitions?
**Options**:
- A) Do not forward terminal execution events: Skip `execution:complete`, `execution:error`, `execution:cancel` to avoid conflicting with `reportJobResult()`. Only forward `execution:start` as `job:status`.
- B) Forward as `log:append` instead: Map all `execution:*` events to `log:append` so they appear in the event stream as informational entries without triggering terminal side effects.
- C) Forward as `job:status` but without terminal status in data: Send the event but omit or rename the `status` field in `data` so the server's terminal-status check is not triggered.
- D) Forward as `job:status` with coordination: Ensure `execution:complete` is sent before `reportJobResult()` and accept the SSE closure, since the result report uses a separate REST endpoint.
**Answer**:

---

### Q6: Error Logging Granularity for Failed Event Forwarding
**Context**: FR-004 requires that `publishEvent()` failures are logged but never thrown. However, in a workflow with many events, a sustained orchestrator outage could generate hundreds of error log lines (one per failed event). This could flood logs and obscure other important messages.
**Question**: What logging strategy should be used for failed event forwarding?
**Options**:
- A) Log every failure: Log each failed `publishEvent()` call individually at `warn` level. Simple but potentially noisy during outages.
- B) Log with rate limiting: Log the first failure, then suppress subsequent failures for the same job, logging only a summary count when forwarding resumes or the job completes.
- C) Log first failure per category: Log the first failure for each event type, then suppress duplicates. Log a summary at job completion showing total forwarded vs. failed.
**Answer**:

---

### Q7: Event Listener Attachment Location
**Context**: The spec says to attach the event listener in `JobHandler.executeJob()`. However, `JobHandler` currently creates the executor internally (line 217-218 of job-handler.ts). The `OrchestratorClient` and `HeartbeatManager` are available via the `JobHandler` constructor, but the event forwarding logic (mapping, error handling, progress tracking) could be implemented either inline in `executeJob()` or extracted into a dedicated class/module.
**Question**: Should the event forwarding logic be implemented inline in `executeJob()` or extracted into a separate module?
**Options**:
- A) Inline in executeJob(): Add the event listener function and mapping logic directly in `executeJob()`. Keeps changes minimal and contained to one file.
- B) Extract to a dedicated EventForwarder class: Create a new class (e.g., `EventForwarder`) that encapsulates mapping, error handling, progress tracking, and batching. Instantiated in `executeJob()` with references to `client` and `heartbeatManager`. Easier to test and extend.
- C) Extract to a standalone function module: Create a helper function (e.g., `createEventForwarder(client, heartbeatManager, jobId, workflow)`) that returns a listener function and a dispose method. Lighter than a class but still testable.
**Answer**:

---

### Q8: Handling `phase:error` Mapping
**Context**: The spec maps `phase:error` to `phase:complete` (with error in data). On the server side, the `phase:complete` event type has no special handling — it's treated as a generic event. However, sending an error-state phase as `phase:complete` could be misleading for monitoring clients that interpret `phase:complete` as successful completion.
**Question**: Should `phase:error` be mapped to `phase:complete` (as the spec states) or to a different event type that better communicates failure?
**Options**:
- A) Map to `phase:complete` with error flag: Keep the spec's mapping. Include `{ status: 'error', error: ... }` in data so clients can distinguish success from failure. Phase completion encompasses both outcomes.
- B) Map to `action:error`: Use the existing error event type. This clearly signals an error but loses the "phase ended" semantic.
- C) Map to `log:append` with error details: Treat phase errors as log entries. The phase simply doesn't get a `phase:complete` event, which clients can interpret as an incomplete phase.
**Answer**:

---

### Q9: Async Fire-and-Forget Implementation
**Context**: The spec requires "fire-and-forget" semantics (FR-004) so the executor's synchronous event emission loop is not blocked. The `ExecutionEventEmitter.emit()` calls listeners synchronously. If the listener calls `publishEvent()` (which is async/returns a Promise), the listener itself must handle the async operation without awaiting it inline — but unhandled promise rejections should still be caught.
**Question**: How should the async `publishEvent()` call be handled within the synchronous event listener?
**Options**:
- A) Void the promise with `.catch()`: Call `publishEvent().catch(err => logger.warn(...))` without awaiting. Simple fire-and-forget with error handling.
- B) Push to an async queue: Add events to an internal queue processed by a `setInterval` or microtask loop. Provides more control over concurrency and ordering.
- C) Use `queueMicrotask` or `Promise.resolve().then()`: Defer the async work to the microtask queue to ensure it runs after the synchronous event emission completes, avoiding any potential reentrancy issues.
**Answer**:

---

### Q10: Duration Calculation for Completed Events
**Context**: FR-008 requires including timing information (duration) in completed events. The executor emits `phase:start` with a timestamp and later `phase:complete` with a timestamp. To compute duration, the forwarder must store start timestamps and compute deltas on completion. However, `ExecutionEvent.timestamp` is set at emission time, so the forwarder could also compute duration as `completeEvent.timestamp - startEvent.timestamp`.
**Question**: Should the event forwarder maintain its own start-time tracking to compute durations, or rely on the timestamps already present in the events?
**Options**:
- A) Track start timestamps in a Map: Store `{ [phaseName]: startTimestamp }` on `:start` events, compute duration as `completeTimestamp - startTimestamp` on `:complete` events, then delete the entry. Explicit and reliable.
- B) Include raw timestamps only: Forward both `startedAt` (from the `:start` event) and `completedAt` (from the `:complete` event) timestamps in the data payload. Let the consumer compute duration. Avoids state tracking.
**Answer**:
