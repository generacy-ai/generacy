# Data Model: Event Forwarding

**Date**: 2026-02-17

## Existing Types (No Changes)

### ExecutionEvent (workflow-engine)

```typescript
// packages/workflow-engine/src/types/events.ts
interface ExecutionEvent {
  type: ExecutionEventType;   // 15 possible values
  timestamp: number;          // Date.now() at emit time
  workflowName: string;
  phaseName?: string;
  stepName?: string;
  message?: string;           // human-readable / stdout content
  data?: unknown;             // PhaseResult, StepResult, RetryState, etc.
}
```

### JobEventType (orchestrator)

```typescript
// packages/generacy/src/orchestrator/types.ts
type JobEventType =
  | 'job:status'
  | 'phase:start'
  | 'phase:complete'
  | 'step:start'
  | 'step:complete'
  | 'step:output'
  | 'action:error'
  | 'log:append';
```

No new values needed — the existing 8 types cover all 15 executor events via the mapping table.

### JobEvent (orchestrator)

```typescript
// packages/generacy/src/orchestrator/types.ts
interface JobEvent {
  id: string;                        // assigned by server (monotonic counter)
  type: JobEventType;
  timestamp: number;
  jobId: string;
  data: Record<string, unknown>;
}
```

## New Types

### EventForwarderOptions

```typescript
// packages/generacy/src/orchestrator/event-forwarder.ts
interface EventForwarderOptions {
  /** OrchestratorClient for publishing events */
  client: OrchestratorClient;

  /** Job ID to publish events for */
  jobId: string;

  /** Logger instance */
  logger: Logger;

  /** Total number of phases in the workflow */
  totalPhases: number;

  /** Map of phase name → number of steps in that phase */
  stepsPerPhase: Map<string, number>;

  /** Called when progress changes */
  onProgress?: (progress: number) => void;

  /** Buffer flush interval in ms (default: 100) */
  flushIntervalMs?: number;

  /** Consecutive failures before opening circuit (default: 10) */
  circuitBreakerThreshold?: number;

  /** Time in ms to keep circuit open before half-open (default: 30000) */
  circuitBreakerResetMs?: number;

  /** Max bytes for step:output event data (default: 65536) */
  maxOutputBytes?: number;
}
```

### CircuitBreakerState (internal)

```typescript
// Internal to EventForwarder
type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerState {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt?: number;       // Date.now() when circuit opened
}
```

### ProgressState (internal)

```typescript
// Internal to EventForwarder
interface ProgressState {
  completedPhases: number;
  currentPhaseName?: string;
  completedStepsInCurrentPhase: number;
  totalStepsInCurrentPhase: number;
  lastReportedProgress: number;
}
```

## Event Data Payloads

Each mapped event sends a `data: Record<string, unknown>` to the orchestrator. The shapes per event type:

### `job:status`

```typescript
// execution:start
{ status: 'running' }

// execution:complete
{ status: 'completed' }

// execution:error
{ status: 'failed', error: string, stack?: string }

// execution:cancel
{ status: 'cancelled' }
```

### `phase:start`

```typescript
{ phaseName: string }
```

### `phase:complete`

```typescript
{ phaseName: string, duration: number }
```

### `step:start`

```typescript
{ phaseName: string, stepName: string }
```

### `step:complete`

```typescript
{ phaseName: string, stepName: string, duration: number }
```

### `step:output`

```typescript
{ phaseName: string, stepName: string, output: string }
// output truncated to 64KB max
```

### `action:error`

```typescript
// From phase:error
{ phaseName: string, error: string, stack?: string }

// From step:error
{ phaseName: string, stepName: string, error: string, stack?: string }

// From action:error
{ phaseName: string, stepName: string, error: string, stack?: string,
  attempts?: number, totalDuration?: number }
```

### `log:append`

```typescript
// From action:start / action:complete
{ phaseName: string, stepName: string, message: string }

// From action:retry
{ phaseName: string, stepName: string, message: string,
  attempt: number, maxAttempts: number }
```
