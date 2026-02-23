# Data Models: Real-time Workflow Log Streaming

## New Types

### LogEntry

Represents a single log chunk stored in the per-job `LogBuffer`. Created when a `log:append` event is received by the orchestrator.

```typescript
// Location: packages/generacy/src/orchestrator/log-buffer.ts

export interface LogEntry {
  /** Monotonic ID within the job's log buffer (1-based) */
  id: number;

  /** Unix epoch milliseconds */
  timestamp: number;

  /** Output stream: 'stdout' or 'stderr' */
  stream: string;

  /** Speckit operation name: 'specify' | 'plan' | 'tasks' | 'implement' | 'clarify' */
  stepName: string;

  /** The log content (may contain multiple lines, newline-delimited) */
  content: string;

  /** Task index within the implement operation (0-based). Only present for implement step. */
  taskIndex?: number;

  /** Task description (truncated to 100 chars). Only present for implement step. */
  taskTitle?: string;
}
```

### StreamBatcher

Utility class that batches string chunks over a configurable time window and flushes them via a callback. Used in speckit operations to reduce event volume from high-frequency `stdout.on('data')` callbacks.

```typescript
// Location: packages/workflow-engine/src/actions/builtin/speckit/lib/stream-batcher.ts

export class StreamBatcher {
  private buffer: string;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    flushCallback: (content: string) => void,
    intervalMs?: number,  // default: 200
  );

  /** Append a chunk to the internal buffer. Starts the flush timer if not running. */
  append(chunk: string): void;

  /** Immediately flush buffered content. Safe to call multiple times. */
  flush(): void;
}
```

### AsyncEventQueue

Bounded async queue for fire-and-forget event posting from the worker to the orchestrator. Provides graceful degradation: drops oldest events on overflow, never blocks the caller.

```typescript
// Location: packages/generacy/src/orchestrator/async-event-queue.ts

export class AsyncEventQueue {
  constructor(
    postFn: (jobId: string, event: object) => Promise<void>,
    maxSize?: number,  // default: 100
  );

  /** Enqueue an event for async posting. Non-blocking. */
  push(jobId: string, event: object): void;

  /** Drain all pending events (for graceful shutdown). */
  flush(): Promise<void>;
}
```

### LogBuffer

Per-job circular buffer for log entries with 10,000 default capacity. Backed by the existing `RingBuffer<T>` class.

```typescript
// Location: packages/generacy/src/orchestrator/log-buffer.ts

export class LogBuffer {
  constructor(capacity?: number);  // default: 10000

  /** Append a log entry. Assigns monotonic ID. Returns the complete entry. */
  append(entry: Omit<LogEntry, 'id'>): LogEntry;

  /** Return all buffered entries in insertion order. */
  getAll(): LogEntry[];

  /** Return entries with ID > sinceId. */
  getAfterId(sinceId: number): LogEntry[];

  /** Clear all entries and reset counter. */
  clear(): void;

  /** Current number of entries. */
  get size(): number;
}
```

### LogBufferManager

Manages per-job `LogBuffer` instances with graceful cleanup after jobs reach terminal state.

```typescript
// Location: packages/generacy/src/orchestrator/log-buffer.ts

export class LogBufferManager {
  constructor(options?: {
    capacity?: number;     // default: 10000
    gracePeriod?: number;  // default: 300000 (5 minutes)
  });

  /** Get or create a LogBuffer for a job. */
  getOrCreate(jobId: string): LogBuffer;

  /** Get an existing LogBuffer (returns undefined if not created). */
  get(jobId: string): LogBuffer | undefined;

  /** Schedule cleanup of a job's log buffer after the grace period. */
  scheduleCleanup(jobId: string): void;

  /** Clean shutdown: clear all timers and buffers. */
  destroy(): void;
}
```

## Modified Types

### CommandOptions (extended)

```typescript
// Location: packages/workflow-engine/src/actions/cli-utils.ts

export interface CommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  // NEW:
  /** Callback for decoded stdout chunks (for real-time streaming) */
  onStdout?: (chunk: string) => void;
  /** Callback for decoded stderr chunks */
  onStderr?: (chunk: string) => void;
}
```

### ActionContext (extended)

```typescript
// Location: packages/workflow-engine/src/types/action.ts

export interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: PhaseDefinition;
  step: StepDefinition;
  inputs: Record<string, unknown>;
  stepOutputs: Map<string, StepOutput>;
  env: Record<string, string>;
  workdir: string;
  signal: AbortSignal;
  logger: Logger;
  // NEW:
  /** Emit a streaming event (log output or step output) */
  emitEvent?: (event: {
    type: 'log:append' | 'step:output';
    data: Record<string, unknown>;
  }) => void;
}
```

### ExecutionEventType (extended)

```typescript
// Location: packages/workflow-engine/src/types/events.ts

export type ExecutionEventType =
  | 'execution:start' | 'execution:complete' | 'execution:error' | 'execution:cancel'
  | 'phase:start' | 'phase:complete' | 'phase:error'
  | 'step:start' | 'step:complete' | 'step:error' | 'step:output'
  | 'action:start' | 'action:complete' | 'action:error' | 'action:retry'
  | 'log:append';  // NEW
```

## Data Flow

```
CLI stdout chunk (Buffer)
  → StringDecoder.write() → decoded string
    → StreamBatcher.append() → batched string (every 200ms)
      → context.emitEvent({ type: 'log:append', data: { stream, stepName, content } })
        → ExecutionEventEmitter.emit(ExecutionEvent)
          → JobHandler event listener
            → AsyncEventQueue.push()
              → OrchestratorClient.publishEvent(jobId, event)
                → POST /api/jobs/:jobId/events
                  → EventBus.publish()
                    ├→ LogBuffer.append(LogEntry)     [storage]
                    └→ SSE broadcast to subscribers    [real-time delivery]
```

## Storage Lifecycle

```
Job created (pending)
  │
  ▼
Job running → log events arrive → LogBuffer accumulates entries (max 10,000)
  │
  ▼
Job reaches terminal state (completed/failed/cancelled)
  │
  ├─ SSE subscribers closed
  ├─ Cleanup timer started (5 min grace period)
  │
  │ ... 5 minutes ...
  │
  ▼
LogBuffer.clear() + delete from LogBufferManager
```
