# Clarification Questions

## Status: Resolved

## Questions

### Q1: Duplicate Status Events from Forwarding execution:* Events
**Context**: The spec maps `execution:start` → `job:status { status: 'running' }`, `execution:complete` → `job:status { status: 'completed' }`, etc. However, `job-handler.ts` already calls `updateJobStatus()` at job start/completion/failure, which likely already publishes `job:status` events or updates the job record. Forwarding executor `execution:*` events as additional `job:status` events could produce duplicate or conflicting status transitions seen by monitoring clients.
**Question**: Should the `execution:*` → `job:status` mapping be skipped to avoid duplicate status events, or should both the existing `updateJobStatus()` calls and the new event forwarding coexist (with clients expected to handle duplicates)?
**Options**:
- A) Skip execution:* forwarding: The existing `updateJobStatus()` already covers status transitions; only forward phase/step/action events
- B) Forward both, deduplicate server-side: Forward all events and rely on the orchestrator's `EventBus` to deduplicate by timestamp or status
- C) Forward both, clients handle duplicates: Forward all events and document that monitoring clients may see redundant `job:status` events
- D) Replace updateJobStatus with event forwarding: Remove the direct `updateJobStatus()` calls and rely solely on event-driven status updates
**Answer**: **A) Skip `execution:*` forwarding.** The existing `updateJobStatus()` calls already handle status transitions reliably. Only forward `phase:*`, `step:*`, and `action:*` events — the purpose of this feature is granular phase/step/action monitoring, not duplicating existing status management.

### Q2: Async publishEvent in Synchronous Event Listener
**Context**: The spec assumes executor events are emitted synchronously, and the `ExecutionEventEmitter` listener signature is a synchronous callback `(event: ExecutionEvent) => void`. However, `publishEvent()` is an async HTTP call. Calling an async function in a synchronous listener means the promise is fire-and-forget — errors may become unhandled promise rejections even with try-catch, and multiple events could be in-flight concurrently with no ordering guarantee.
**Question**: How should async `publishEvent()` calls be handled within the synchronous event listener to ensure proper error handling and event ordering?
**Options**:
- A) Fire-and-forget with .catch(): Call `publishEvent().catch(log)` — simplest, accepts out-of-order delivery
- B) Internal queue with sequential processing: Enqueue events and process them sequentially via an async drain loop to guarantee ordering
- C) Fire-and-forget for non-critical, queue for critical: Use fire-and-forget for `step:output` but sequential queue for phase/step lifecycle events
**Answer**: **B) Internal queue with sequential processing.** An async drain loop guarantees event ordering, which matters for monitoring clients reconstructing workflow state (e.g., dashboards showing phase/step progression). The queue is simple to implement (array with a `drainLoop()` that shifts and awaits) and provides proper error handling without unhandled promise rejections.

### Q3: phase:error and step:error Mapping to action:error
**Context**: The mapping table maps `phase:error` and `step:error` to `action:error`. This is semantically confusing — a phase-level or step-level error is not an action error. Monitoring clients consuming `action:error` events would need to inspect the data payload to distinguish between an actual action failure, a step failure, and a phase failure. This could complicate client-side event handling and dashboard display.
**Question**: Should `phase:error` and `step:error` be mapped to `action:error` as specified, or should they be handled differently?
**Options**:
- A) Keep mapping as specified: Map both to `action:error` with distinguishing context fields like `{ level: 'phase' }` or `{ level: 'step' }`
- B) Drop phase:error and step:error: These are already covered by `phase:complete` (with failed status in data) and `step:error` (existing label logic) — don't forward them separately
- C) Map to job:status instead: Forward as `job:status` with error details, since they represent higher-level failures, not action-level errors
**Answer**: **B) Drop them.** These are redundant — `phase:complete` and `step:complete` events already carry success/failure status in their data payload. Mapping them to `action:error` is semantically wrong. Monitoring clients can derive error states from lifecycle completion events.

### Q4: Progress Calculation When Phases Have Unequal Step Counts
**Context**: The progress formula `((completedPhases + phaseProgress) / totalPhases) * 100` weights each phase equally regardless of how many steps it contains. A phase with 1 step contributes the same to overall progress as a phase with 20 steps. This could cause the progress bar to jump unevenly — e.g., a 2-phase workflow where phase 1 has 1 step and phase 2 has 19 steps would show 50% after just 1 step, then slowly crawl from 50% to 100% over 19 steps.
**Question**: Should progress be weighted by phase count (equal weight per phase) or by total step count (equal weight per step)?
**Options**:
- A) Equal weight per phase (as specified): Keep the formula as-is; simpler to implement, phases represent logical milestones
- B) Equal weight per step: Use `completedSteps / totalSteps * 100` across all phases; gives smoother, more granular progress
- C) Configurable weighting: Allow the workflow definition to specify phase weights; fall back to equal-per-step if not specified
**Answer**: **B) Equal weight per step.** Use `completedSteps / totalSteps * 100` across all phases for smoother, more honest progress. Users expect progress bars to correlate with actual work done. Still simple to implement and gives much better UX.

### Q5: Log Level and Verbosity for Forwarding Failures
**Context**: The spec says to log forwarding errors at `warn` level. In workflows with many steps, if the orchestrator is temporarily unreachable, this could produce hundreds of warn-level log entries (one per failed event), which may flood logs and obscure other important warnings. The spec doesn't specify whether to throttle, deduplicate, or limit these log messages.
**Question**: Should warn-level logging for forwarding failures be throttled or capped to avoid log flooding during orchestrator outages?
**Options**:
- A) Log every failure at warn: Simple approach, consistent; rely on log aggregation tooling to filter
- B) Log first failure at warn, subsequent at debug: Log the first failure per job at `warn` level, then downgrade to `debug` for subsequent failures until success resumes
- C) Log with rate limiting: Log at most one warn per 30 seconds per job, with a count of suppressed failures
**Answer**: **B) First at warn, subsequent at debug.** Use a simple boolean flag per job (`hasLoggedForwardingFailure`). First failure logs at `warn`, subsequent failures downgrade to `debug`. Reset the flag when forwarding succeeds again so the next failure gets warn-level visibility. Avoids log flooding without losing important diagnostics.

### Q6: Scope of P3 Batching — Implement Now or Defer?
**Context**: FR-007 and FR-008 describe batching for high-frequency `step:output` events, marked as P3 priority. The spec includes detailed batching design (100ms timer, 50-event max, critical event flush) but also marks it as optional. It's unclear whether this should be implemented as part of this feature or deferred entirely. Implementing batching adds meaningful complexity (timer management, buffer lifecycle, flush-before-result coordination) for an optimization that may not be needed initially.
**Question**: Should P3 batching be implemented in this feature, or deferred to a follow-up?
**Options**:
- A) Implement now: Include batching as part of this feature to handle `step:output` volume from day one
- B) Defer entirely: Ship without batching; add it only if `step:output` volume causes performance issues in practice
- C) Implement simplified version: Add a basic debounce for `step:output` only (no full buffer/flush infrastructure)
**Answer**: **B) Defer entirely.** YAGNI. The sequential queue from Q2 already provides natural buffering. Batching adds meaningful complexity for an optimization that may never be needed. Ship without it, measure actual `step:output` volume in practice, and add batching as a focused follow-up only if performance issues materialize.

### Q7: Workflow Definition Access for Step Counts
**Context**: The progress calculation requires knowing the total number of phases and steps per phase upfront. The spec assumes the workflow definition is available in the event listener scope, but the listener is registered in `job-handler.ts` while the workflow definition is passed to `executor.execute()`. The spec doesn't clarify how the listener obtains access to the definition's phase/step structure — it may need to be captured in a closure or extracted before execution starts.
**Question**: How should the event listener access the workflow definition's phase and step counts for progress calculation?
**Options**:
- A) Closure capture: Extract phase/step counts from the workflow definition before calling `executor.execute()` and capture them in the listener closure
- B) Derive from events: Track phase/step counts dynamically as `phase:start` and `step:start` events arrive, without needing the workflow definition upfront
- C) Add to ExecutionEvent: Extend `ExecutionEvent` to include `totalPhases` and `totalSteps` fields so the listener is self-contained
**Answer**: **A) Closure capture.** The workflow definition is already loaded and available in `job-handler.ts` before `executor.execute()` is called. Extract phase/step counts into local variables and capture them in the listener closure. Deterministic (totals known upfront), doesn't require modifying `ExecutionEvent` types, and simpler than deriving counts dynamically.

### Q8: Forwarding Events for Cancelled Jobs
**Context**: When a job is cancelled via `execution:cancel`, the spec maps this to `job:status { status: 'cancelled' }`. However, the orchestrator's event endpoint has special behavior for terminal status events — it closes all subscribers and schedules cleanup. If the cancellation races with in-flight forwarded events, some events may be lost or rejected. The spec doesn't address whether event forwarding should stop immediately upon cancellation or attempt to flush remaining events.
**Question**: When a job is cancelled, should the event forwarding listener continue forwarding any remaining events, or should it stop immediately?
**Options**:
- A) Stop immediately on cancel: Set a flag on `execution:cancel` and skip forwarding any subsequent events
- B) Continue forwarding: Let all events flow through naturally; the orchestrator handles cleanup after a grace period anyway
- C) Flush then stop: Flush any buffered events (if batching is implemented), forward the cancel event, then stop
**Answer**: **C) Flush then stop.** Events emitted before cancellation represent real work that was done — monitoring clients benefit from seeing the complete picture. Since batching is deferred (Q6), this simplifies to: forward the cancel event, then set a flag to skip subsequent events.
