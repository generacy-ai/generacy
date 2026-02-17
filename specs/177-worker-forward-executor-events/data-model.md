# Data Model: Event Forwarding

## New Types

### EventForwarderOptions

```typescript
interface EventForwarderOptions {
  /** Orchestrator REST client for publishing events */
  client: OrchestratorClient;
  /** Job ID to publish events for */
  jobId: string;
  /** Total number of phases in the workflow (for progress calculation) */
  totalPhases: number;
  /** Logger instance */
  logger: Logger;
  /** Callback for progress updates (wired to HeartbeatManager externally) */
  onProgress?: (jobId: string, progress: number) => void;
  /** Batch flush interval in ms (default: 100) */
  batchIntervalMs?: number;
  /** Max buffer size before dropping oldest deferred events (default: 100) */
  maxBufferSize?: number;
}
```

### Internal State (EventForwarder)

```typescript
// Progress tracking
private completedPhases: number = 0;
private totalPhases: number;

// Batching
private pendingEvents: Array<{ type: JobEventType; data: Record<string, unknown>; timestamp: number }> = [];
private flushTimer: ReturnType<typeof setTimeout> | null = null;
private isFlushing: boolean = false;

// Lifecycle
private subscription: { dispose: () => void } | null = null;
```

## Event Mapping (ExecutionEventType -> JobEventType)

### Skipped Events (handled by existing updateJobStatus/reportJobResult)

| ExecutionEventType | Reason |
|---|---|
| `execution:start` | Duplicate — `updateJobStatus('running')` already publishes `job:status` |
| `execution:complete` | Duplicate — `reportJobResult()` triggers terminal `job:status` |
| `execution:error` | Duplicate — `reportJobResult()` triggers terminal `job:status` |
| `execution:cancel` | Duplicate — `reportJobResult()` triggers terminal `job:status` |

### Forwarded Events

| ExecutionEventType | JobEventType | Priority | Data |
|---|---|---|---|
| `phase:start` | `phase:start` | Immediate | `{ phaseName, workflowName }` |
| `phase:complete` | `phase:complete` | Immediate | `{ phaseName, workflowName, duration? }` |
| `phase:error` | `phase:complete` | Immediate | `{ phaseName, workflowName, error, status: 'failed' }` |
| `step:start` | `step:start` | Immediate | `{ stepName, phaseName, workflowName }` |
| `step:complete` | `step:complete` | Immediate | `{ stepName, phaseName, workflowName, duration? }` |
| `step:error` | `step:complete` | Immediate | `{ stepName, phaseName, error, status: 'failed' }` |
| `step:output` | `step:output` | Deferred | `{ stepName, phaseName, message?, data? }` |
| `action:start` | `log:append` | Deferred | `{ message, level: 'info', source: 'action:start' }` |
| `action:complete` | `log:append` | Deferred | `{ message, level: 'info', source: 'action:complete' }` |
| `action:error` | `action:error` | Immediate | `{ stepName, phaseName, error, data? }` |
| `action:retry` | `log:append` | Deferred | `{ message, level: 'warn', source: 'action:retry' }` |

### Priority Classification

**Immediate flush** (structural/error events):
- `phase:start`, `phase:complete`, `phase:error`
- `step:start`, `step:complete`, `step:error`
- `action:error`

**Deferred flush** (high-frequency/informational events):
- `step:output`
- `action:start`, `action:complete`, `action:retry`

## Error Serialization

Error data is extracted from `ExecutionEvent.data` or `ExecutionEvent.message`:

```typescript
function extractErrorMessage(event: ExecutionEvent): string {
  if (event.message) return event.message;
  if (event.data && typeof event.data === 'object') {
    const data = event.data as Record<string, unknown>;
    if (typeof data.error === 'string') return data.error;
    if (data.error instanceof Error) return data.error.message;
    if (typeof data.message === 'string') return data.message;
  }
  return 'Unknown error';
}
```

Truncation: Error messages are truncated to 4096 characters.

## Progress Model

```
progress = Math.round((completedPhases / totalPhases) * 100)
```

- Updated on `phase:complete` and `phase:error` events (both increment `completedPhases`)
- Range: 0-100
- Reaches 100 only when all phases complete
- Propagated via `onProgress(jobId, progress)` callback

## Existing Types (No Changes)

### JobEventType (types.ts:204-212) — unchanged
```typescript
type JobEventType =
  | 'job:status'
  | 'phase:start' | 'phase:complete'
  | 'step:start' | 'step:complete' | 'step:output'
  | 'action:error'
  | 'log:append';
```

### ExecutionEvent (workflow-engine) — unchanged
```typescript
interface ExecutionEvent {
  type: ExecutionEventType;
  timestamp: number;
  workflowName: string;
  phaseName?: string;
  stepName?: string;
  message?: string;
  data?: unknown;
}
```

### publishEvent API (client.ts:178-183) — unchanged
```typescript
publishEvent(
  jobId: string,
  event: { type: JobEventType; data: Record<string, unknown>; timestamp?: number },
): Promise<{ eventId: string }>
```
