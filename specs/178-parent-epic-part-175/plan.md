# Implementation Plan: Real-time Workflow Log Streaming

## Summary

Add real-time stdout/stderr streaming from `claude -p` processes through the workflow engine to the orchestrator, enabling live monitoring of speckit operations (specify, plan, tasks, implement) via SSE.

**Approach**: Extend `executeCommand()` with streaming callbacks, add `log:append` event type to the workflow engine, forward lifecycle + log events from the executor through the `JobHandler` to the orchestrator, create a dedicated `LogBuffer` for per-job log storage, and expose a `GET /api/jobs/:jobId/logs` retrieval endpoint.

## Technical Context

- **Language**: TypeScript (ESM modules)
- **Runtime**: Node.js
- **Packages**: `@generacy-ai/workflow-engine`, `@generacy-ai/generacy` (orchestrator)
- **Server**: Native `http` module (no Express)
- **Process management**: `child_process.spawn()` with detached process groups
- **Event system**: Custom `ExecutionEventEmitter` → `EventBus` with `RingBuffer`

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Workflow Engine (Worker)                                     │
│                                                             │
│  executeCommand()                                           │
│    └─ proc.stdout.on('data') ──► StringDecoder             │
│         └─ onStdout(chunk) ──► StreamBatcher (200ms)        │
│              └─ emitEvent({ type:'log:append', ... })       │
│                   └─ ExecutionEventEmitter                   │
│                        └─ executor.addEventListener()        │
└────────────────────────────┬────────────────────────────────┘
                             │ (event callback in JobHandler)
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ JobHandler (Worker → Orchestrator Bridge)                    │
│                                                             │
│  executor.addEventListener((event) => {                     │
│    asyncQueue.push(event) ──► POST /api/jobs/:jobId/events  │
│  })                                                         │
│                          (bounded queue, drop on overflow)   │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP POST
                             ▼
┌─────────────────────────────────────────────────────────────┐
│ Orchestrator Server                                          │
│                                                             │
│  POST /api/jobs/:jobId/events ──► EventBus.publish()        │
│    ├─ log:append → LogBuffer.append() + SSE broadcast       │
│    └─ lifecycle  → RingBuffer.push()  + SSE broadcast       │
│                                                             │
│  GET /api/jobs/:jobId/logs ──► LogBuffer.getEntries()       │
│    ├─ ?since=<id>   → incremental fetch                     │
│    └─ ?stream=true  → SSE live stream from LogBuffer        │
│                                                             │
│  GET /api/jobs/:jobId/events ──► existing SSE (all events)  │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Streaming Callbacks in `executeCommand()` (P1)

**Files**:
- `packages/workflow-engine/src/actions/cli-utils.ts`

**Changes**:

1. Add `onStdout` and `onStderr` optional callbacks to `CommandOptions`:
   ```typescript
   export interface CommandOptions {
     cwd?: string;
     env?: Record<string, string>;
     timeout?: number;
     signal?: AbortSignal;
     onStdout?: (chunk: string) => void;
     onStderr?: (chunk: string) => void;
   }
   ```

2. In `executeCommand()`, use Node's `StringDecoder` to handle multi-byte UTF-8 characters across chunk boundaries. Wire `proc.stdout.on('data')` and `proc.stderr.on('data')` to invoke the callbacks while still accumulating the full output strings:
   ```typescript
   import { StringDecoder } from 'node:string_decoder';

   // Inside executeCommand:
   const stdoutDecoder = new StringDecoder('utf8');
   const stderrDecoder = new StringDecoder('utf8');

   proc.stdout.on('data', (data: Buffer) => {
     const decoded = stdoutDecoder.write(data);
     stdout += decoded;
     options.onStdout?.(decoded);
   });

   proc.stderr.on('data', (data: Buffer) => {
     const decoded = stderrDecoder.write(data);
     stderr += decoded;
     options.onStderr?.(decoded);
   });

   // On 'close', flush remaining bytes:
   proc.on('close', (code) => {
     const remaining = stdoutDecoder.end() + stderrDecoder.end();
     // ... handle remaining
   });
   ```

3. Existing behavior is fully preserved — callbacks are optional, stdout/stderr strings still accumulated.

**Tests**:
- Unit test: `executeCommand` with `onStdout` callback receives chunks from a short-lived process (e.g., `echo "hello"`)
- Unit test: Multi-byte UTF-8 characters are not garbled across chunk boundaries
- Unit test: Callbacks are not invoked when not provided (backward compatibility)

---

### Phase 2: `log:append` Event Type in Workflow Engine (P1)

**Files**:
- `packages/workflow-engine/src/types/events.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/specify.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`
- `packages/workflow-engine/src/types/action.ts`

**Changes**:

1. Add `'log:append'` to `ExecutionEventType` union:
   ```typescript
   export type ExecutionEventType =
     | 'execution:start' | 'execution:complete' | 'execution:error' | 'execution:cancel'
     | 'phase:start' | 'phase:complete' | 'phase:error'
     | 'step:start' | 'step:complete' | 'step:error' | 'step:output'
     | 'action:start' | 'action:complete' | 'action:error' | 'action:retry'
     | 'log:append';
   ```

2. Add `emitEvent` to `ActionContext` with constrained union type:
   ```typescript
   export interface ActionContext {
     // ... existing fields
     /** Emit a streaming event (log output or step output) */
     emitEvent?: (event: {
       type: 'log:append' | 'step:output';
       data: Record<string, unknown>;
     }) => void;
   }
   ```

3. Create a `StreamBatcher` utility class (new file: `packages/workflow-engine/src/actions/builtin/speckit/lib/stream-batcher.ts`):
   ```typescript
   /**
    * Batches string chunks over a time window and calls a flush callback.
    * Used to reduce event volume from high-frequency stdout data events.
    */
   export class StreamBatcher {
     private buffer = '';
     private timer: ReturnType<typeof setTimeout> | null = null;

     constructor(
       private readonly flushCallback: (content: string) => void,
       private readonly intervalMs: number = 200,
     ) {}

     append(chunk: string): void {
       this.buffer += chunk;
       if (!this.timer) {
         this.timer = setTimeout(() => this.flush(), this.intervalMs);
       }
     }

     flush(): void {
       if (this.timer) {
         clearTimeout(this.timer);
         this.timer = null;
       }
       if (this.buffer.length > 0) {
         this.flushCallback(this.buffer);
         this.buffer = '';
       }
     }
   }
   ```

4. In each speckit operation that calls `executeCommand('claude', ...)`, create `StreamBatcher` instances and pass `onStdout`/`onStderr` callbacks. Example for `specify.ts`:
   ```typescript
   const stdoutBatcher = new StreamBatcher((content) => {
     context.emitEvent?.({
       type: 'log:append',
       data: {
         stream: 'stdout',
         stepName: 'specify',
         content,
       },
     });
   });

   const stderrBatcher = new StreamBatcher((content) => {
     context.emitEvent?.({
       type: 'log:append',
       data: {
         stream: 'stderr',
         stepName: 'specify',
         content,
       },
     });
   });

   const result = await executeCommand('claude', args, {
     cwd: input.feature_dir,
     timeout,
     signal: context.signal,
     onStdout: (chunk) => stdoutBatcher.append(chunk),
     onStderr: (chunk) => stderrBatcher.append(chunk),
   });

   // Flush remaining batched content
   stdoutBatcher.flush();
   stderrBatcher.flush();
   ```

5. For `implement.ts`, include `taskIndex` and `taskTitle` in the log entry data:
   ```typescript
   data: {
     stream: 'stdout',
     stepName: 'implement',
     taskIndex: idx,
     taskTitle: task.description.substring(0, 100),
     content,
   }
   ```

**Tests**:
- Unit test: `StreamBatcher` batches chunks within the interval and flushes on timeout
- Unit test: `StreamBatcher.flush()` immediately emits buffered content
- Unit test: Verify `emitEvent` is called with correct data shape from operations

---

### Phase 3: Wire `emitEvent` in Executor (P1)

**Files**:
- `packages/workflow-engine/src/executor/index.ts`

**Changes**:

1. When constructing `ActionContext` in `executeWithActionHandler()`, add `emitEvent` that delegates to the executor's `ExecutionEventEmitter`:
   ```typescript
   const actionContext: ActionContext = {
     // ... existing fields
     emitEvent: (event) => {
       this.eventEmitter.emitEvent(
         event.type as ExecutionEventType,
         workflow.name,
         {
           phaseName: phase.name,
           stepName: step.name ?? step.id,
           data: event.data,
         }
       );
     },
   };
   ```

2. This requires no changes to the `ExecutionEventEmitter` itself — it already handles arbitrary `ExecutionEventType` values and passes `data` through.

**Tests**:
- Integration test: Execute a workflow step with a mock action that calls `context.emitEvent()`, verify the event is emitted via `executor.addEventListener()`

---

### Phase 4: Forward Events from JobHandler to Orchestrator (P1)

**Files**:
- `packages/generacy/src/orchestrator/job-handler.ts`

**Changes**:

1. Create an `AsyncEventQueue` utility (new file: `packages/generacy/src/orchestrator/async-event-queue.ts`):
   ```typescript
   /**
    * Bounded async queue that posts events to the orchestrator.
    * Fire-and-forget: drops oldest events on overflow.
    * Never blocks the caller.
    */
   export class AsyncEventQueue {
     private queue: Array<{ jobId: string; event: object }> = [];
     private processing = false;
     private readonly maxSize: number;
     private readonly postFn: (jobId: string, event: object) => Promise<void>;

     constructor(postFn: (jobId: string, event: object) => Promise<void>, maxSize = 100) {
       this.postFn = postFn;
       this.maxSize = maxSize;
     }

     push(jobId: string, event: object): void {
       if (this.queue.length >= this.maxSize) {
         this.queue.shift(); // Drop oldest
       }
       this.queue.push({ jobId, event });
       this.processQueue();
     }

     private async processQueue(): Promise<void> {
       if (this.processing) return;
       this.processing = true;
       try {
         while (this.queue.length > 0) {
           const item = this.queue.shift()!;
           try {
             await this.postFn(item.jobId, item.event);
           } catch {
             // Silently drop failed events — non-critical telemetry
           }
         }
       } finally {
         this.processing = false;
       }
     }

     /** Flush all pending events (for graceful shutdown) */
     async flush(): Promise<void> {
       await this.processQueue();
     }
   }
   ```

2. In `JobHandler.executeJob()`, after creating the executor, set up event forwarding:
   ```typescript
   // Event types to forward (lifecycle + logs, skip action-level granularity)
   const forwardTypes = new Set([
     'phase:start', 'phase:complete',
     'step:start', 'step:complete', 'step:output',
     'log:append',
   ]);

   const eventQueue = new AsyncEventQueue(async (jobId, event) => {
     await this.client.publishEvent(jobId, event as {
       type: string;
       data: Record<string, unknown>;
       timestamp?: number;
     });
   });

   executor.addEventListener((event) => {
     // Existing logic for step:error and phase:complete (labels) stays as-is

     // Forward matching events to orchestrator
     if (forwardTypes.has(event.type)) {
       eventQueue.push(job.id, {
         type: event.type,
         timestamp: event.timestamp,
         data: {
           phaseName: event.phaseName,
           stepName: event.stepName,
           message: event.message,
           ...(event.data as Record<string, unknown> ?? {}),
         },
       });
     }
   });
   ```

3. In the `finally` block, call `eventQueue.flush()` to drain pending events before the job completes.

**Tests**:
- Unit test: `AsyncEventQueue` drops oldest events when queue overflows
- Unit test: `AsyncEventQueue` does not block the caller on post failure
- Integration test: Verify lifecycle events appear in orchestrator SSE stream

---

### Phase 5: LogBuffer and Log Retrieval Endpoint (P1)

**Files**:
- New: `packages/generacy/src/orchestrator/log-buffer.ts`
- `packages/generacy/src/orchestrator/server.ts`
- `packages/generacy/src/orchestrator/event-bus.ts`

**Changes**:

1. Create `LogBuffer` class that reuses `RingBuffer` with 10,000 capacity:
   ```typescript
   import { RingBuffer } from './event-bus.js';

   export interface LogEntry {
     /** Monotonic ID within the job's log buffer */
     id: number;
     /** Unix epoch ms */
     timestamp: number;
     /** 'stdout' or 'stderr' */
     stream: string;
     /** Speckit operation name */
     stepName: string;
     /** The log content */
     content: string;
     /** Optional task identifier for implement operation */
     taskIndex?: number;
     taskTitle?: string;
   }

   export class LogBuffer {
     private readonly buffer: RingBuffer<LogEntry>;
     private counter = 0;

     constructor(capacity = 10000) {
       this.buffer = new RingBuffer<LogEntry>(capacity);
     }

     append(entry: Omit<LogEntry, 'id'>): LogEntry {
       const full: LogEntry = { ...entry, id: ++this.counter };
       this.buffer.push(full);
       return full;
     }

     getAll(): LogEntry[] {
       return this.buffer.getAll();
     }

     getAfterId(sinceId: number): LogEntry[] {
       return this.buffer.getAfterIndex(sinceId - 1);
     }

     clear(): void {
       this.buffer.clear();
       this.counter = 0;
     }

     get size(): number {
       return this.buffer.size;
     }
   }
   ```

2. Create `LogBufferManager` to manage per-job log buffers with cleanup:
   ```typescript
   export class LogBufferManager {
     private readonly buffers = new Map<string, LogBuffer>();
     private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
     private readonly capacity: number;
     private readonly gracePeriod: number;

     constructor(options?: { capacity?: number; gracePeriod?: number }) {
       this.capacity = options?.capacity ?? 10000;
       this.gracePeriod = options?.gracePeriod ?? 300000; // 5 min, aligned with EventBus
     }

     getOrCreate(jobId: string): LogBuffer {
       let buf = this.buffers.get(jobId);
       if (!buf) {
         buf = new LogBuffer(this.capacity);
         this.buffers.set(jobId, buf);
       }
       return buf;
     }

     get(jobId: string): LogBuffer | undefined {
       return this.buffers.get(jobId);
     }

     scheduleCleanup(jobId: string): void {
       const existing = this.cleanupTimers.get(jobId);
       if (existing) clearTimeout(existing);

       const timer = setTimeout(() => {
         this.buffers.get(jobId)?.clear();
         this.buffers.delete(jobId);
         this.cleanupTimers.delete(jobId);
       }, this.gracePeriod);
       this.cleanupTimers.set(jobId, timer);
     }

     destroy(): void {
       for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
       this.cleanupTimers.clear();
       this.buffers.clear();
     }
   }
   ```

3. Modify `EventBus.publish()` to detect `log:append` events and route them to the `LogBufferManager` (store in LogBuffer) while still broadcasting via SSE. The log events are NOT stored in the EventBus's per-job `RingBuffer` (to avoid drowning out lifecycle events):
   ```typescript
   // In EventBus constructor, accept optional LogBufferManager
   constructor(options: EventBusOptions & { logBufferManager?: LogBufferManager }) {
     // ...
     this.logBufferManager = options.logBufferManager;
   }

   async publish(jobId: string, event: Omit<JobEvent, 'id'>): Promise<JobEvent> {
     const counter = (this.counters.get(jobId) ?? 0) + 1;
     this.counters.set(jobId, counter);
     const fullEvent: JobEvent = { ...event, id: String(counter) };

     // Route log events to LogBuffer instead of RingBuffer
     if (event.type === 'log:append' && this.logBufferManager) {
       const logBuffer = this.logBufferManager.getOrCreate(jobId);
       logBuffer.append({
         timestamp: event.timestamp,
         stream: (event.data as Record<string, unknown>).stream as string,
         stepName: (event.data as Record<string, unknown>).stepName as string,
         content: (event.data as Record<string, unknown>).content as string,
         taskIndex: (event.data as Record<string, unknown>).taskIndex as number | undefined,
         taskTitle: (event.data as Record<string, unknown>).taskTitle as string | undefined,
       });
     } else {
       // Store lifecycle events in the RingBuffer as before
       let buffer = this.buffers.get(jobId);
       if (!buffer) {
         buffer = new RingBuffer<JobEvent>(this.bufferSize);
         this.buffers.set(jobId, buffer);
       }
       buffer.push(fullEvent);
     }

     // SSE broadcast happens for ALL event types (unchanged)
     // ...
   }
   ```

4. Add `GET /api/jobs/:jobId/logs` endpoint to `server.ts`:
   ```typescript
   // Route:
   const jobLogsRoute = pathToRegex('/api/jobs/:jobId/logs');

   // Handler:
   async getJobLogs(req, res, params) {
     const { jobId } = params;
     const url = new URL(req.url!, `http://${req.headers.host}`);
     const sinceParam = url.searchParams.get('since');
     const streamParam = url.searchParams.get('stream');

     const logBuffer = logBufferManager.get(jobId);
     if (!logBuffer) {
       sendJson(res, 200, { entries: [], total: 0 });
       return;
     }

     // SSE streaming mode
     if (streamParam === 'true') {
       res.writeHead(200, {
         'Content-Type': 'text/event-stream',
         'Cache-Control': 'no-cache',
         'Connection': 'keep-alive',
         'X-Accel-Buffering': 'no',
       });
       res.flushHeaders();

       // Send existing entries first
       const entries = sinceParam
         ? logBuffer.getAfterId(parseInt(sinceParam, 10))
         : logBuffer.getAll();
       for (const entry of entries) {
         res.write(`event: log:append\nid: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
       }

       // Subscribe to live log events via EventBus
       // (reuse per-job subscriber mechanism)
       eventBus.subscribe(jobId, res);
       return;
     }

     // JSON mode: return buffered entries
     const entries = sinceParam
       ? logBuffer.getAfterId(parseInt(sinceParam, 10))
       : logBuffer.getAll();

     sendJson(res, 200, { entries, total: logBuffer.size });
   }
   ```

5. Wire `LogBufferManager` cleanup into the existing terminal-state handling: when `scheduleCleanup` is called on the `EventBus`, also call `logBufferManager.scheduleCleanup(jobId)`.

**Tests**:
- Unit test: `LogBuffer` append, getAll, getAfterId, capacity eviction
- Unit test: `LogBufferManager` per-job buffer creation and cleanup scheduling
- Unit test: `EventBus` routes `log:append` to LogBuffer, lifecycle events to RingBuffer
- Integration test: POST a `log:append` event, GET `/api/jobs/:jobId/logs` returns it
- Integration test: SSE subscribers receive `log:append` events in real-time

---

### Phase 6: Export and Index Updates (P1)

**Files**:
- `packages/workflow-engine/src/types/index.ts` — export `log:append` type
- `packages/generacy/src/orchestrator/index.ts` — export `LogBuffer`, `LogBufferManager`

**Changes**: Ensure new types and classes are properly exported for consumers.

---

## API Contracts

### Existing Endpoint (modified behavior)

**`POST /api/jobs/:jobId/events`** — Already accepts `log:append` type. No changes needed.

Request body:
```json
{
  "type": "log:append",
  "timestamp": 1234567890123,
  "data": {
    "stream": "stdout",
    "stepName": "specify",
    "content": "Reading extension/src/extension.ts...\n",
    "taskIndex": 2,
    "taskTitle": "Add error handling"
  }
}
```

### New Endpoint

**`GET /api/jobs/:jobId/logs`** — Retrieve buffered log output.

Query parameters:
- `since` (optional): LogEntry ID — return entries after this ID
- `stream` (optional): `true` — switch to SSE streaming mode

JSON response (when `stream` is not `true`):
```json
{
  "entries": [
    {
      "id": 1,
      "timestamp": 1234567890123,
      "stream": "stdout",
      "stepName": "specify",
      "content": "Reading extension/src/extension.ts...\n"
    }
  ],
  "total": 42
}
```

SSE response (when `stream=true`):
```
event: log:append
id: 1
data: {"id":1,"timestamp":1234567890123,"stream":"stdout","stepName":"specify","content":"..."}

event: log:append
id: 2
data: ...
```

See `contracts/log-endpoints.yaml` for full OpenAPI specification.

## Data Models

See `data-model.md` for complete data model documentation.

Key new types:
- `LogEntry` — Individual log line stored in `LogBuffer`
- `StreamBatcher` — Time-based chunk batching utility
- `AsyncEventQueue` — Bounded fire-and-forget event posting queue

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Batching strategy | Time-batched at 200ms | Prevents RingBuffer overflow while maintaining acceptable latency for a log viewer (~300 events/min max) |
| Event type | New `log:append` in `ExecutionEventType` | Clean 1:1 mapping with existing `JobEventType`. Preserves `step:output` semantics (post-completion full output) |
| Event forwarding scope | Lifecycle + logs (skip `action:*`) | Lifecycle events needed for parent epic #175. `action:*` too granular. Minimal additional effort once infrastructure exists |
| Log buffer vs EventBus buffer | Separate LogBuffer with 10K capacity | Prevents log events from drowning out lifecycle events in the 1K EventBus RingBuffer |
| Log event posting | Separate endpoint for retrieval only | Reuse existing `POST /events` for ingestion; new `GET /logs` for log-specific retrieval with `?since=` and `?stream=true` |
| UTF-8 handling | `StringDecoder` | Built-in Node.js, negligible overhead, prevents garbled SSE frames from split multi-byte characters |
| Cleanup grace period | 5 minutes (aligned with EventBus) | Consistent, predictable. Gives reconnecting clients time to catch up |
| `emitEvent` type safety | Optional with union type `'log:append' \| 'step:output'` | Compile-time safety on event names while maintaining backward compatibility |
| Error handling for event posts | Async queue, drop on overflow (100 capacity) | Never blocks Claude process execution. Bounded memory. Standard telemetry pattern |
| `executeShellCommand` streaming | Deferred | Only used for short-lived `gh` CLI calls. No current use case for streaming |
| Implement task identity | Include `taskIndex` and `taskTitle` | Essential for monitoring UI to distinguish output from different task iterations |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| High event volume overwhelms SSE connections | 200ms batching reduces max event rate to ~5/sec per stream; LogBuffer capacity bounded at 10K |
| Event posting slows down Claude process | AsyncEventQueue is fire-and-forget, never awaited. Queue bounded at 100, drops oldest on overflow |
| Memory leak from unbounded log buffers | LogBufferManager.scheduleCleanup() aligns with EventBus grace period. Per-job buffers cleared after terminal state + 5 min |
| Split UTF-8 characters break SSE JSON | StringDecoder ensures complete characters at chunk boundaries |
| Backward compatibility with existing ActionContext consumers | `emitEvent` is optional (`?`). All existing code works without modification |
| Partial log data on reconnection | `GET /api/jobs/:jobId/logs?since=<id>` supports incremental fetch. LogBuffer tracks monotonic IDs with RingBuffer's `getAfterIndex` |

## File Change Summary

### New Files
| File | Description |
|------|-------------|
| `packages/workflow-engine/src/actions/builtin/speckit/lib/stream-batcher.ts` | Time-based chunk batching utility |
| `packages/generacy/src/orchestrator/log-buffer.ts` | LogBuffer and LogBufferManager classes |
| `packages/generacy/src/orchestrator/async-event-queue.ts` | Bounded async event posting queue |

### Modified Files
| File | Changes |
|------|---------|
| `packages/workflow-engine/src/actions/cli-utils.ts` | Add `onStdout`/`onStderr` to `CommandOptions`, wire to spawn, use `StringDecoder` |
| `packages/workflow-engine/src/types/events.ts` | Add `'log:append'` to `ExecutionEventType` |
| `packages/workflow-engine/src/types/action.ts` | Add `emitEvent?` to `ActionContext` |
| `packages/workflow-engine/src/executor/index.ts` | Wire `emitEvent` into `ActionContext` construction |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/specify.ts` | Add `StreamBatcher` + `onStdout`/`onStderr` callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` | Add `StreamBatcher` + `onStdout`/`onStderr` callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks.ts` | Add `StreamBatcher` + `onStdout`/`onStderr` callbacks |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts` | Add `StreamBatcher` + `onStdout`/`onStderr` callbacks with `taskIndex`/`taskTitle` |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` | Add `StreamBatcher` + `onStdout`/`onStderr` callbacks |
| `packages/generacy/src/orchestrator/job-handler.ts` | Add event forwarding via `AsyncEventQueue` for lifecycle + log events |
| `packages/generacy/src/orchestrator/event-bus.ts` | Route `log:append` to `LogBufferManager` instead of `RingBuffer` |
| `packages/generacy/src/orchestrator/server.ts` | Add `GET /api/jobs/:jobId/logs` route, instantiate `LogBufferManager` |

## Testing Strategy

### Unit Tests
- `cli-utils.ts`: Streaming callbacks invoked with correct content; StringDecoder handles multi-byte chars; backward compatibility
- `stream-batcher.ts`: Batching interval, flush behavior, empty flush no-op
- `async-event-queue.ts`: Bounded capacity, drop on overflow, error resilience, flush
- `log-buffer.ts`: Append, getAll, getAfterId, capacity eviction, clear
- `event-bus.ts`: log:append routed to LogBuffer; lifecycle events stored in RingBuffer; SSE broadcast for both

### Integration Tests
- Spawn a short-lived process via `executeCommand()` with streaming callbacks → verify chunks received
- Execute a mock workflow step → verify `log:append` events flow through `ExecutionEventEmitter`
- POST `log:append` event to orchestrator → GET `/api/jobs/:jobId/logs` → verify entries returned
- SSE subscriber connects → POST events → verify real-time delivery

---

*Generated by speckit*
