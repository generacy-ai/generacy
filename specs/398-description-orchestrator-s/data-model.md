# Data Model: Orchestrator Job Lifecycle Events

## New Types

### RelayJobEvent

Added to the `RelayMessage` discriminated union in `packages/orchestrator/src/types/relay.ts`.

```typescript
/**
 * Job lifecycle event sent from worker to cloud via relay WebSocket.
 * Matches the cloud API's EventMessage type for direct handling by
 * MessageHandler.handleEvent().
 */
interface RelayJobEvent {
  type: 'event';
  /** Job lifecycle event name (e.g., 'job:created', 'job:phase_changed') */
  event: string;
  /** Event payload with job metadata */
  data: Record<string, unknown>;
  /** ISO 8601 timestamp of event emission */
  timestamp: string;
}
```

### JobEventEmitter

Callback type for emitting job events, added to `packages/orchestrator/src/worker/types.ts`.

```typescript
/**
 * Callback for emitting job lifecycle events through the relay WebSocket.
 * Fire-and-forget — implementations must not throw.
 */
type JobEventEmitter = (event: string, data: Record<string, unknown>) => void;
```

## Modified Types

### WorkerContext

Add `jobId` field to `packages/orchestrator/src/worker/types.ts`:

```typescript
interface WorkerContext {
  // ... existing fields ...

  /** Job UUID generated at dequeue time for lifecycle event correlation */
  jobId: string;
}
```

### ClaudeCliWorkerDeps

Add `jobEventEmitter` to `packages/orchestrator/src/worker/claude-cli-worker.ts`:

```typescript
interface ClaudeCliWorkerDeps {
  processFactory?: ProcessFactory;
  sseEmitter?: SSEEventEmitter;
  /** Callback for emitting job lifecycle events through the relay */
  jobEventEmitter?: JobEventEmitter;
}
```

### PhaseLoopDeps

Add `jobEventEmitter` to `packages/orchestrator/src/worker/phase-loop.ts`:

```typescript
interface PhaseLoopDeps {
  // ... existing fields ...

  /** Optional callback for emitting job lifecycle events */
  jobEventEmitter?: JobEventEmitter;
}
```

### RelayMessage Union

Update in `packages/orchestrator/src/types/relay.ts`:

```typescript
type RelayMessage =
  | RelayApiRequest
  | RelayApiResponse
  | RelayEvent
  | RelayJobEvent      // NEW
  | RelayMetadata
  | RelayConversationInput
  | RelayConversationOutput;
```

## Event Payloads

### job:created

```typescript
{
  jobId: string;            // UUID v4
  workflowName: string;     // 'speckit-feature' | 'speckit-bugfix' | 'speckit-epic'
  owner: string;            // GitHub org/user
  repo: string;             // GitHub repo name
  issueNumber: number;      // GitHub issue number
  status: 'active';
  currentStep: string;      // Starting phase (e.g., 'specify')
}
```

### job:phase_changed

```typescript
{
  jobId: string;
  workflowName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  status: 'active';
  currentStep: string;      // Phase about to begin (e.g., 'clarify')
}
```

### job:paused

```typescript
{
  jobId: string;
  workflowName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  status: 'paused';
  currentStep: string;      // Phase that triggered the gate
  gateLabel: string;        // e.g., 'waiting-for:clarification'
}
```

### job:completed

```typescript
{
  jobId: string;
  workflowName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  status: 'completed';
  currentStep: string;      // Last completed phase
}
```

### job:failed

```typescript
{
  jobId: string;
  workflowName: string;
  owner: string;
  repo: string;
  issueNumber: number;
  status: 'failed';
  currentStep: string;      // Phase that failed
  error: string;            // Error message
}
```

## Validation Rules

- `jobId` must be a valid UUID v4 (generated via `crypto.randomUUID()`)
- `event` must be one of: `'job:created'`, `'job:phase_changed'`, `'job:paused'`, `'job:completed'`, `'job:failed'`
- `timestamp` must be a valid ISO 8601 string
- `status` values are constrained per event type (see payloads above)
- `currentStep` must be a valid `WorkflowPhase` value

## Relationships

```
WorkerDispatcher
  └─ claims QueueItem
      └─ ClaudeCliWorker.handle(item)
          ├─ generates jobId (UUID)
          ├─ emits job:created ──────────────────┐
          ├─ PhaseLoop.executeLoop()              │
          │   ├─ emits job:phase_changed ─────────┤
          │   ├─ emits job:paused (at gate) ──────┤
          │   └─ returns PhaseLoopResult           │
          ├─ emits job:completed ─────────────────┤
          └─ emits job:failed ────────────────────┤
                                                   │
                                     JobEventEmitter callback
                                                   │
                                     ClusterRelayClient.send()
                                                   │
                                     Cloud API MessageHandler.handleEvent()
                                                   │
                                     Firestore + SSE broadcast
```
