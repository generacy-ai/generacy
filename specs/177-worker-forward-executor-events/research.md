# Research: Worker Event Forwarding

## Clarification Decisions

### Q1: Duplicate `job:status` Events — **Option A: Skip `execution:*` events**

**Decision**: The EventForwarder should NOT forward `execution:start/complete/error/cancel` as `job:status` events.

**Rationale**:
- `JobHandler.executeJob()` already calls `client.updateJobStatus(job.id, 'running')` at line 207, which triggers the server's `PUT /api/jobs/:jobId/status` handler. That handler auto-publishes a `job:status` event via EventBus (server.ts:587-593) AND handles terminal cleanup (`closeJobSubscribers`/`scheduleCleanup`).
- `client.reportJobResult()` at line 248 triggers the same terminal status event path on the server.
- Forwarding `execution:*` as `job:status` would produce duplicate events AND trigger `closeJobSubscribers`/`scheduleCleanup` twice for terminal events.
- Option A is the safest: zero behavioral changes to existing status flow, no double-cleanup risk.

### Q2: HeartbeatManager Access — **Option B: Use a progress callback**

**Decision**: Add an `onProgress?: (jobId: string, progress: number) => void` callback to `JobHandlerOptions`.

**Rationale**:
- Keeps `JobHandler` decoupled from `HeartbeatManager` — follows existing callback pattern (`onJobStart`, `onJobComplete`, `onError`).
- The worker command wires the callback: `onProgress: (jobId, progress) => heartbeatManager.setCurrentJob(jobId, progress)`.
- No need to import or depend on `HeartbeatManager` type in JobHandler.
- Consistent with existing architecture in worker.ts lines 154-170.

### Q3: Total Phase Count Source — **Option A: Pass to EventForwarder**

**Decision**: Pass `totalPhases` (and optionally per-phase step counts) to the EventForwarder constructor.

**Rationale**:
- The `execution:start` event does NOT include phase count in its data payload (confirmed: executor/index.ts:157-159 emits only `{ message: 'Starting workflow: ...' }`).
- The workflow definition is loaded and prepared in `JobHandler.executeJob()` at line 226 (`prepareWorkflow` returns an `ExecutableWorkflow` with `workflow.phases`).
- After `prepareWorkflow()`, `workflow.phases.length` is available. Pass it to EventForwarder.
- No changes to the workflow-engine package required.

### Q4: Batch Flush Semantics — **Option A: Sequential within a batch**

**Decision**: Send events sequentially within each batch flush.

**Rationale**:
- Ordering matters for monitoring clients: receiving `step:complete` before `step:start` is confusing.
- Event forwarding is non-blocking (fire-and-forget), so sequential sending within a batch does not block the executor.
- The 100ms batch window already reduces HTTP overhead significantly. Sequential sends within a batch are fast (typical latency <10ms per call to a local orchestrator).
- Adding sequence numbers (Option B) pushes complexity to clients. Accepting reordering (Option C) degrades UX.

### Q5: Error Data Serialization — **Option B: Structured extraction**

**Decision**: Extract `{ message, code?, stack? }` from error objects with truncation.

**Rationale**:
- Message-only (Option A) loses actionable context like error codes.
- Best-effort JSON (Option C) risks circular references and unpredictable payloads.
- Structured extraction is predictable, safe, and provides enough context for debugging.
- Truncate total error data to 4KB to prevent oversized payloads.
- Omit stack traces or truncate them — they're useful for debugging but can be large.

### Q6: EventForwarder Lifecycle — **Option A: Per-job instance**

**Decision**: Create a new `EventForwarder` for each `executeJob()` call.

**Rationale**:
- Simple, no state leakage between jobs.
- Per-job state (jobId, progress counters, batch buffer, phase/step tracking) is naturally scoped.
- Created after workflow loading (so `totalPhases` is available), disposed in `finally` block.
- Follows the existing pattern: `WorkflowExecutor` is also created per-job in `executeJob()`.

### Q7: Step-Level Progress Granularity — **Option A: Phase-level only**

**Decision**: Initial implementation uses phase-level progress only.

**Rationale**:
- Phase-level progress is simpler and already provides meaningful feedback.
- Step-level granularity requires tracking total steps per phase, which adds complexity for marginal UX improvement.
- Can be added as a follow-up enhancement if needed.
- Formula: `progress = Math.round((completedPhases / totalPhases) * 100)`.

### Q8: Buffer Size Limit — **Option A: Hard cap with drop**

**Decision**: Set a maximum buffer size (100 events). Drop oldest deferred events when full.

**Rationale**:
- Prevents unbounded memory growth during orchestrator outages or slow responses.
- Priority events (phase/step complete, errors) still flush immediately regardless of buffer state.
- Dropped events are logged at `warn` level so operators can detect the issue.
- 100 events is generous — the 100ms flush + 20-event threshold means the buffer should rarely exceed 20 in practice.

### Q9: `log:append` Data Payload — **Option A: Simple message format**

**Decision**: Use `{ message: string, level?: 'info' | 'warn', source?: string }` format.

**Rationale**:
- `log:append` hasn't been used before — establishing a simple, consistent format is better than a complex one.
- Human-readable messages are the primary use case for action events in monitoring UIs.
- `source` field allows distinguishing event origin (e.g., `'action:start'`, `'action:retry'`).
- Additional data (like `retryAttempt`/`maxRetries`) can be included in the message string itself.

## Key Architecture Findings

### Existing Event Flow (server.ts)

The `PUT /api/jobs/:jobId/status` endpoint already:
1. Updates job status in the queue
2. Auto-publishes a `job:status` event via EventBus (line 587-593)
3. Handles terminal cleanup (line 596-600)

The `POST /api/jobs/:jobId/events` endpoint:
1. Validates event type against `JobEventType` allowlist (line 517-525)
2. Validates `data` is a non-null object (line 528-531)
3. Publishes to EventBus (line 533-538)
4. Handles terminal `job:status` events (line 540-545)

### ExecutionEventEmitter Pattern (events.ts)

- `addEventListener()` returns `{ dispose: () => void }` — standard disposable pattern
- Listeners are called synchronously from the executor
- The emitter catches listener errors to prevent them from affecting other listeners
- Listener callbacks are `(event: ExecutionEvent) => void` — must be sync, forwarding must be async fire-and-forget

### WorkflowExecutor Lifecycle

In `job-handler.ts` line 229-242:
1. Executor created: `new WorkflowExecutor({ logger })`
2. Execute called: `executor.execute(workflow, options, inputs)`
3. No event listener registered — this is the gap we're filling

The workflow object (after `prepareWorkflow()`) contains `phases: PhaseDefinition[]` where each phase has `steps: StepDefinition[]`. This provides the total phase count for progress calculation.

### HeartbeatManager Integration

`setCurrentJob(jobId, progress)` at heartbeat.ts:96 already accepts an optional `progress` parameter. The heartbeat payload includes `progress?: number` (types.ts:144). Currently called without progress in worker.ts:157.
