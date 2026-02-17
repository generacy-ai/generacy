# Clarification Questions

## Status: Pending

## Questions

### Q1: Heartbeat Progress API Mismatch
**Context**: The spec's implementation sketch references `this.heartbeatManager?.setProgress(...)`, but the `HeartbeatManager` class has no `setProgress()` method. Progress is set via `setCurrentJob(jobId, progress?)`. Furthermore, the `HeartbeatManager` is not currently passed to `JobHandler` — it lives in `worker.ts` and is accessed only through the `onJobStart`/`onJobComplete` callbacks.
**Question**: How should the JobHandler update heartbeat progress? Should we (A) add a `HeartbeatManager` reference to `JobHandlerOptions` so it can call `setCurrentJob` with progress directly, or (B) add a new callback like `onProgress?: (jobId: string, progress: number) => void` to keep the existing decoupled architecture?
**Options**:
- A) Inject HeartbeatManager: Pass the `HeartbeatManager` instance into `JobHandler` via options. Simpler code but creates a direct dependency between the two.
- B) Add onProgress callback: Add `onProgress?: (jobId: string, progress: number) => void` to `JobHandlerOptions`. The `worker.ts` wiring code calls `heartbeatManager.setCurrentJob(jobId, progress)` in the callback. Keeps existing decoupled pattern consistent with `onJobStart`/`onJobComplete`.
**Answer**:

---

### Q2: Listener Type Mismatch — Sync vs Async
**Context**: The `ExecutionEventListener` type is defined as `(event: ExecutionEvent) => void` (synchronous). The spec's implementation sketch defines the listener as `async (event: ExecutionEvent) => { ... await this.client.publishEvent(...) }`, which returns a `Promise<void>`, not `void`. The emitter's `emit()` method calls `listener(event)` without awaiting, so the returned promise would be silently discarded — meaning errors from `publishEvent` wouldn't be caught by the emitter's try/catch.
**Question**: Is the fire-and-forget async pattern acceptable here, or should the listener be synchronous with the `publishEvent` call wrapped in a self-contained `void promise.catch(...)` pattern?
**Options**:
- A) Fire-and-forget async: Keep the `async` listener as sketched. The emitter won't await it, but the internal try/catch handles errors. Unhandled rejections are avoided because the try/catch is inside the async function.
- B) Sync listener with void catch: Use a synchronous listener that calls `void this.client.publishEvent(...).catch(err => this.logger.warn(...))`. More explicit about the fire-and-forget intent and avoids the async/sync type mismatch.
**Answer**:

---

### Q3: Skipped Phases and Progress Calculation
**Context**: The spec calculates progress as `completedPhases / totalPhases * 100` where `totalPhases = workflow.phases.length`. However, the executor supports conditional phases (`phase.condition`) that can be skipped at runtime. Skipped phases emit `phase:start` followed by a second `phase:complete` or `phase:error` event (the executor re-emits on finalization at line 347-355), but they also return early before executing steps. This means the progress denominator may overcount, and the progress calculation won't reach 100% if phases are skipped without emitting `phase:complete`.
**Question**: How should skipped phases affect progress calculation?
**Options**:
- A) Count skipped as completed: Increment `completedPhases` on both `phase:complete` and skipped phases (detect via `event.data.status === 'skipped'`). Progress reflects "phases processed" rather than "phases executed."
- B) Dynamic denominator: Reduce `totalPhases` when a phase is skipped, so progress = `completedPhases / (totalPhases - skippedPhases) * 100`. More accurate but more complex.
- C) Keep simple, accept inaccuracy: Use the spec as-is. If phases are skipped, progress may not reach 100% until the final `execution:complete` event (which is currently filtered out). Accept this as a known limitation.
**Answer**:

---

### Q4: Duration Data Availability in Completion Events
**Context**: FR-006 requires including `duration` for completion events extracted from `event.data`. The executor emits `phase:complete` events with `data: result` where `result` is the full `PhaseResult` object (which has a `duration` field). Similarly, `step:complete` events include the `StepResult` as data. However, the `event.data` field is typed as `unknown`, and the spec's data payload uses a spread: `...typeof event.data === 'object' ? event.data as Record<string, unknown> : {}`. This would forward the entire `PhaseResult`/`StepResult` (including nested `stepResults`, `outputs`, etc.) — far more data than intended.
**Question**: Should the forwarded event data include only curated fields (phaseName, stepName, duration, message) or spread the full executor result object?
**Options**:
- A) Curated fields only: Explicitly extract `duration` from `event.data` for completion events and only forward named fields (phaseName, stepName, duration, message). Clean, predictable payloads.
- B) Spread full event.data: Forward everything from `event.data` as the spec sketches. Richer data for debugging but potentially large payloads with nested step results, action outputs, etc.
- C) Curated with optional detail: Forward curated fields by default, but include a `detail` key with the full `event.data` for error events only (where the extra context aids debugging).
**Answer**:

---

### Q5: Duplicate phase:complete/phase:error Emission
**Context**: Looking at the executor code, when a phase fails, the emitter fires `phase:error` inside the catch block (line 331) AND then fires either `phase:complete` or `phase:error` again in the finalization block (line 347-348, based on `result.status`). This means a failed phase emits TWO `phase:error` events. The progress counter would be incremented incorrectly if it listens for both, and duplicate events would be forwarded to the orchestrator.
**Question**: Should the event forwarder deduplicate phase completion/error events, or is this an upstream bug that should be fixed in the executor?
**Options**:
- A) Deduplicate in forwarder: Track which phases have already had a completion/error event forwarded and skip duplicates. Defensive approach that works regardless of executor behavior.
- B) Fix in executor: Remove the duplicate emission in the executor's finalization block when the phase already errored. Fixes the root cause but requires changing the workflow-engine package.
- C) Forward both, let orchestrator handle: Don't deduplicate. The orchestrator should be idempotent for duplicate events. Simplest implementation but may confuse progress tracking.
**Answer**:

---

### Q6: Event Forwarding for the Catch Block (Job Failure Path)
**Context**: The spec's implementation sketch places event subscription and forwarding in the try block only. If `executor.execute()` throws (catch block, lines 250-272 of job-handler.ts), the executor may have emitted events before the error that should still be forwarded. More importantly, the `subscription.dispose()` is noted for the finally block, but the subscription variable is scoped inside the try block in the sketch — it won't be accessible in finally.
**Question**: Should the subscription variable be declared before the try block (at `executeJob` scope) to ensure it's accessible in the finally block for disposal? And should events emitted before an execution error still be forwarded?
**Options**:
- A) Declare at method scope: Declare `subscription` as `let subscription: { dispose: () => void } | undefined` before the try block. Dispose in finally with `subscription?.dispose()`. Events emitted before failure are still forwarded since the listener is active.
- B) Subscribe in try, dispose in finally via closure: Use a mutable reference (e.g., a variable in the outer scope) to hold the subscription. Same effect but the sketch needs adjustment.
**Answer**:

---

### Q7: Concurrency of Event Forwarding and Execution
**Context**: The `ExecutionEventListener` is synchronous (`=> void`), and the emitter calls listeners synchronously within `emit()`. If the listener triggers an async `publishEvent()` call, multiple events can be in-flight concurrently. If the executor emits events rapidly (e.g., multiple `step:output` events), there could be many concurrent HTTP requests to the orchestrator. There's no backpressure mechanism, and the spec's optional batching (FR-008/FR-009) is P3/deferred.
**Question**: Should we add a concurrency limit or sequential queue for `publishEvent` calls to avoid overwhelming the orchestrator, or is unbounded concurrency acceptable for the initial implementation?
**Options**:
- A) Unbounded concurrency: Let all `publishEvent` calls fire concurrently. Simple, matches the fire-and-forget philosophy. If the orchestrator can't keep up, events are dropped (try/catch).
- B) Sequential queue: Process events one at a time via a simple promise chain. Guarantees event ordering at the cost of potential delays if the orchestrator is slow.
- C) Bounded concurrency: Allow up to N concurrent requests (e.g., 5), queue the rest. Balances throughput and resource usage.
**Answer**:

---

### Q8: step:output Volume and Payload Size
**Context**: `step:output` events can fire frequently during execution (e.g., streaming LLM output, build logs). The spec notes batching as P3/deferred (FR-008). Without batching, every `step:output` triggers an individual HTTP POST to the orchestrator. For a chatty step, this could mean hundreds of requests in seconds. The `publishEvent` endpoint presumably has no rate limiting documented.
**Question**: Should `step:output` events be forwarded individually like other events, or should they receive special handling (e.g., throttling, sampling, or exclusion) in the initial implementation?
**Options**:
- A) Forward all individually: Treat `step:output` the same as other events. Simple and complete. Defer optimization.
- B) Throttle step:output: Forward at most one `step:output` per step per 500ms, dropping intermediate outputs. Reduces volume without losing visibility.
- C) Exclude step:output initially: Skip forwarding `step:output` entirely in v1. It's the highest-volume, lowest-priority event. Can be added with batching later.
**Answer**:

---

### Q9: Event Mapping Function Location
**Context**: The spec mentions a `mapEventType()` function for mapping `ExecutionEventType` to `JobEventType`, but doesn't specify where this function should live. It could be a private method on `JobHandler`, a standalone utility in `types.ts`, or an inline map/switch in the listener callback.
**Question**: Where should the event type mapping logic be implemented?
**Options**:
- A) Private method on JobHandler: `private mapEventType(type: ExecutionEventType): JobEventType`. Co-located with the usage, easy to test via the class.
- B) Standalone function in types.ts: Export a `mapExecutorEventType()` function alongside the type definitions. Reusable and independently testable.
- C) Inline const map: Define a `Record<ExecutionEventType, JobEventType | null>` constant at module level in job-handler.ts. Simple lookup, no function overhead.
**Answer**:

---

### Q10: Testing Strategy for Event Forwarding
**Context**: The spec defines success criteria (SC-001 through SC-005) requiring unit tests, but doesn't specify whether existing test infrastructure supports mocking the executor's event emission. The `WorkflowExecutor` creates its `EventEmitter` internally, so tests would need to either (a) use real executor with test workflows, (b) mock the executor, or (c) test the event forwarding logic in isolation.
**Question**: What testing approach should be used for the event forwarding feature?
**Options**:
- A) Integration with real executor: Create minimal test workflows that trigger all event types. Verify `publishEvent` calls via a mocked client. Most realistic but slower and more complex to set up.
- B) Mock executor events: Create a mock executor that exposes `addEventListener` and manually emits events. Test the forwarding logic in isolation. Fast and focused but doesn't validate real event shapes.
- C) Extract and unit test: Extract the event mapping and forwarding logic into a separate testable function/class. Unit test the mapping and error handling independently, with a thin integration test for the wiring.
**Answer**:
