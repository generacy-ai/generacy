# Research: Event Forwarding Technical Decisions

## Existing Infrastructure Discovery

### `publishEvent()` Already Exists

The spec mentions adding a `postJobEvent()` method to `OrchestratorClient`, but investigation reveals that `publishEvent()` already exists at `client.ts:185-190`:

```typescript
async publishEvent(
  jobId: string,
  event: { type: JobEventType; data: Record<string, unknown>; timestamp?: number },
): Promise<{ eventId: string }>
```

This method posts to `POST /api/jobs/:jobId/events` — exactly the endpoint we need. **No client changes required.**

### HeartbeatManager is External to JobHandler

The `HeartbeatManager` and `JobHandler` are separate objects wired together in the CLI commands (`worker.ts`, `agent.ts`). The heartbeat manager's progress is set via callbacks:

```typescript
// worker.ts:162-163
heartbeatManager.setStatus('busy');
heartbeatManager.setCurrentJob(job.id);
```

Currently, progress is never set (only job ID). To surface step-level progress in heartbeats, the `onJobStart` callback would need to receive a reference to a progress tracker. However, this is **out of scope** — the spec focuses on event forwarding, not heartbeat enhancement. Progress is included in the forwarded `step:complete` events for monitoring clients.

### Event Listener is Synchronous

`ExecutionEventListener` is typed as `(event: ExecutionEvent) => void` (not async). This confirms the need for the async queue approach (Q2). The listener callback must remain synchronous — it enqueues events and lets the drain loop handle async I/O.

### Existing Phase-Gate Listener

`job-handler.ts:330-357` already has an `addEventListener` call that handles phase gates and step error tracking. The event forwarder will be registered as a **separate listener** to maintain clean separation of concerns. `ExecutionEventEmitter.addEventListener()` supports multiple listeners.

## Event Type Mapping Analysis

### Executor Events (14 total)

From `workflow-engine/src/types/events.ts`:
- `execution:start`, `execution:complete`, `execution:error`, `execution:cancel` (4 lifecycle events)
- `phase:start`, `phase:complete`, `phase:error` (3 phase events)
- `step:start`, `step:complete`, `step:error`, `step:output` (4 step events)
- `action:start`, `action:complete`, `action:error`, `action:retry` (4 action events)

### Orchestrator Event Types (8 total)

From `orchestrator/types.ts:204-212`:
- `job:status` — handled by existing `updateJobStatus()`
- `phase:start`, `phase:complete` — direct mapping
- `step:start`, `step:complete`, `step:output` — direct mapping
- `action:error` — maps from both `action:error` and `action:retry`
- `log:append` — not used in this feature (could be used for `step:output` but `step:output` is more semantic)

### Filtering Rationale

**7 events forwarded**, **7 events dropped**:

| Dropped | Reason |
|---------|--------|
| `execution:*` (4) | Duplicate of existing status management (Q1) |
| `phase:error` | Redundant with `phase:complete` carrying failure status (Q3) |
| `step:error` | Redundant with `step:complete` carrying failure status (Q3) |
| `action:start` / `action:complete` | No matching `JobEventType`; too granular for orchestrator monitoring |

## Queue Design Alternatives Considered

### Option A: Fire-and-forget with `.catch()`
- Simplest approach
- No ordering guarantee — concurrent HTTP calls finish in arbitrary order
- Unhandled rejections possible if `.catch()` misses edge cases
- **Rejected** per Q2: ordering matters for state reconstruction

### Option B: Promise chain
```typescript
let chain = Promise.resolve();
listener = (event) => { chain = chain.then(() => publishEvent(...)).catch(...); };
```
- Guarantees ordering
- Growing chain reference; harder to flush/stop
- No clear way to inspect queue depth
- **Considered** but queue approach is clearer

### Option C: Array queue with drain loop (chosen)
- Clear separation: enqueue is sync, processing is async
- Easy to flush (await drain), stop (set flag + clear array), inspect (queue.length)
- Natural backpressure: if drain is slow, queue grows; when stopped, queue is cleared
- **Chosen** per Q2

## Progress Calculation Details

### Step Count Extraction (Q7)

Workflow phases are available after `prepareWorkflow()` (line 296) and phase filtering (lines 299-305). The total step count should be calculated **after** phase filtering to avoid counting skipped phases:

```typescript
const totalSteps = workflow.phases.reduce((sum, p) => sum + p.steps.length, 0);
```

This correctly handles:
- Workflows with varying step counts per phase
- Phases skipped due to `completed:*` labels
- The `setup` phase (always included, its steps count toward progress)

### Edge Cases

- **Zero steps**: `totalSteps === 0` → progress stays at 0 (avoid division by zero)
- **Conditional steps**: Steps with `condition` that evaluate to false still count toward total (they still emit `step:complete` with skipped status). If they don't emit events, progress may not reach 100% — acceptable tradeoff for simplicity.
- **Cancelled mid-execution**: Progress reflects work actually completed at time of cancellation.
