# Tasks: Real-time Workflow Log Streaming

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Streaming Callbacks in `executeCommand()`

### T001 [DONE] Add `onStdout`/`onStderr` callbacks to `CommandOptions`
**File**: `packages/workflow-engine/src/actions/cli-utils.ts`
- Add `onStdout?: (chunk: string) => void` to `CommandOptions` interface
- Add `onStderr?: (chunk: string) => void` to `CommandOptions` interface
- Import `StringDecoder` from `node:string_decoder`
- Create `stdoutDecoder` and `stderrDecoder` instances in `executeCommand()`
- Wire `proc.stdout.on('data')` to decode via `StringDecoder`, accumulate to `stdout` string, and invoke `options.onStdout?.(decoded)`
- Wire `proc.stderr.on('data')` to decode via `StringDecoder`, accumulate to `stderr` string, and invoke `options.onStderr?.(decoded)`
- On `proc.on('close')`, flush remaining bytes from both decoders with `.end()`
- Ensure existing behavior is fully preserved — callbacks are optional, stdout/stderr strings still accumulated

---

## Phase 2: Event Types and Utilities

### T002 [DONE] [P] Add `log:append` to `ExecutionEventType`
**File**: `packages/workflow-engine/src/types/events.ts`
- Add `| 'log:append'` to the `ExecutionEventType` union type

### T003 [DONE] [P] Add `emitEvent` to `ActionContext`
**File**: `packages/workflow-engine/src/types/action.ts`
- Add optional `emitEvent` method to `ActionContext` interface:
  ```typescript
  emitEvent?: (event: {
    type: 'log:append' | 'step:output';
    data: Record<string, unknown>;
  }) => void;
  ```

### T004 [DONE] [P] Create `StreamBatcher` utility
**File**: `packages/workflow-engine/src/actions/builtin/speckit/lib/stream-batcher.ts` (new)
- Create `StreamBatcher` class with constructor accepting `flushCallback` and optional `intervalMs` (default 200ms)
- Implement `append(chunk: string)` — accumulates to internal buffer, starts timer on first chunk
- Implement `flush()` — clears timer, calls `flushCallback` with accumulated buffer if non-empty
- Timer fires `flush()` after `intervalMs` to batch high-frequency chunks

---

## Phase 3: Wire Streaming into Speckit Operations

### T005 [DONE] Wire `emitEvent` into `ActionContext` in Executor
**File**: `packages/workflow-engine/src/executor/index.ts`
- In the `createActionContext()` method (or wherever `ActionContext` is constructed), add `emitEvent` that delegates to `this.eventEmitter.emitEvent()`
- Pass `workflow.name`, `phase.name`, `step.name ?? step.id` as context
- `emitEvent` should accept the constrained event type and forward as an `ExecutionEvent`

### T006 [DONE] [P] Add streaming callbacks to `specify` operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/specify.ts`
- Import `StreamBatcher` from `../lib/stream-batcher.js`
- Create `stdoutBatcher` with flush callback that calls `context.emitEvent?.({ type: 'log:append', data: { stream: 'stdout', stepName: 'specify', content } })`
- Create `stderrBatcher` with flush callback for stderr
- Pass `onStdout: (chunk) => stdoutBatcher.append(chunk)` and `onStderr: (chunk) => stderrBatcher.append(chunk)` to `executeCommand()`
- Call `stdoutBatcher.flush()` and `stderrBatcher.flush()` after `executeCommand()` resolves

### T007 [DONE] [P] Add streaming callbacks to `plan` operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts`
- Same pattern as T006 with `stepName: 'plan'`

### T008 [DONE] [P] Add streaming callbacks to `tasks` operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks.ts`
- Same pattern as T006 with `stepName: 'tasks'`

### T009 [DONE] [P] Add streaming callbacks to `implement` operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`
- Same pattern as T006 with `stepName: 'implement'`
- Include `taskIndex` and `taskTitle` (truncated to 100 chars) in the log entry data for each per-task `executeCommand()` call
- Each task iteration gets its own `StreamBatcher` pair

### T010 [DONE] [P] Add streaming callbacks to `clarify` operation
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`
- Same pattern as T006 with `stepName: 'clarify'`

---

## Phase 4: Event Forwarding from Worker to Orchestrator

### T011 [DONE] Create `AsyncEventQueue` utility
**File**: `packages/generacy/src/orchestrator/async-event-queue.ts` (new)
- Create `AsyncEventQueue` class with constructor accepting `postFn` and optional `maxSize` (default 100)
- Implement `push(jobId, event)` — adds to bounded queue, drops oldest on overflow, triggers async processing
- Implement `processQueue()` — processes items sequentially, silently drops on post failure
- Implement `flush()` — drains all pending events (for graceful shutdown)
- Queue is fire-and-forget: never blocks the caller

### T012 [DONE] Add event forwarding in `JobHandler`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Import `AsyncEventQueue` from `./async-event-queue.js`
- Define `forwardTypes` set: `phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`, `log:append`
- Create `AsyncEventQueue` instance in `executeJob()` with `this.client.publishEvent` as the post function
- In `executor.addEventListener()`, check if `event.type` is in `forwardTypes` and push to queue
- Preserve existing event handler logic (step:error tracking, phase labels)
- Call `eventQueue.flush()` in the `finally` block before job completion

---

## Phase 5: Log Buffer and Orchestrator Endpoint

### T013 [DONE] Create `LogBuffer` and `LogBufferManager`
**File**: `packages/generacy/src/orchestrator/log-buffer.ts` (new)
- Define `LogEntry` interface: `id`, `timestamp`, `stream`, `stepName`, `content`, optional `taskIndex`, `taskTitle`
- Create `LogBuffer` class wrapping `RingBuffer<LogEntry>` with 10,000 default capacity
  - `append(entry)` — assigns monotonic ID, pushes to ring buffer
  - `getAll()` — returns all entries
  - `getAfterId(sinceId)` — returns entries after given ID using `RingBuffer.getAfterIndex()`
  - `clear()` — clears buffer and resets counter
  - `size` getter
- Create `LogBufferManager` class
  - Manages `Map<string, LogBuffer>` per job
  - `getOrCreate(jobId)` — lazily creates buffers
  - `get(jobId)` — returns existing buffer or undefined
  - `scheduleCleanup(jobId)` — sets 5-minute timer to clear and delete buffer
  - `destroy()` — clears all timers and buffers

### T014 [DONE] Route `log:append` events to `LogBuffer` in `EventBus`
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Accept optional `LogBufferManager` in `EventBus` constructor options
- In `publish()`, detect `log:append` events and route to `LogBufferManager.getOrCreate(jobId).append()` instead of the per-job `RingBuffer`
- SSE broadcast still happens for all event types (unchanged)
- In `scheduleCleanup()`, also call `logBufferManager.scheduleCleanup(jobId)`
- Export `RingBuffer` class if not already exported (needed by `LogBuffer`)

### T015 [DONE] Add `GET /api/jobs/:jobId/logs` endpoint
**File**: `packages/generacy/src/orchestrator/server.ts`
- Instantiate `LogBufferManager` and pass to `EventBus` constructor
- Add route pattern for `/api/jobs/:jobId/logs`
- Implement handler supporting:
  - **JSON mode** (default): return `{ entries, total }` from `LogBuffer`
  - **`?since=<id>`**: return entries after given ID for incremental fetching
  - **`?stream=true`**: SSE mode — send existing entries, then subscribe to live events via `EventBus`
- Return `{ entries: [], total: 0 }` for unknown job IDs (not 404)

---

## Phase 6: Exports and Index Updates

### T016 [DONE] [P] Update workflow-engine type exports
**File**: `packages/workflow-engine/src/types/index.ts`
- Verify `ExecutionEventType` with `log:append` is exported (should be automatic if already re-exported)
- Verify updated `ActionContext` with `emitEvent` is exported

### T017 [DONE] [P] Update orchestrator exports
**File**: `packages/generacy/src/orchestrator/index.ts`
- Export `LogBuffer`, `LogBufferManager`, `LogEntry` from `./log-buffer.js`
- Export `AsyncEventQueue` from `./async-event-queue.js`

---

## Phase 7: Testing

### T018 [DONE] [P] Unit tests for `executeCommand` streaming callbacks
**Files**: `packages/workflow-engine/src/actions/__tests__/cli-utils.test.ts`
- Test: `onStdout` callback receives chunks from a short-lived process (e.g., `echo "hello"`)
- Test: `onStderr` callback receives stderr output
- Test: Multi-byte UTF-8 characters are not garbled across chunk boundaries
- Test: Callbacks are not invoked when not provided (backward compatibility)
- Test: Full stdout/stderr strings still accumulated correctly when callbacks are present

### T019 [DONE] [P] Unit tests for `StreamBatcher`
**Files**: `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/stream-batcher.test.ts`
- Test: Batches chunks within the 200ms interval and flushes on timeout
- Test: `flush()` immediately emits buffered content and clears timer
- Test: Empty `flush()` is a no-op (does not call flushCallback)
- Test: Multiple rapid `append()` calls result in single flush

### T020 [DONE] [P] Unit tests for `AsyncEventQueue`
**Files**: `packages/generacy/src/orchestrator/__tests__/async-event-queue.test.ts`
- Test: Events are posted via `postFn` in order
- Test: Drops oldest events when queue exceeds `maxSize`
- Test: Does not block the caller on `postFn` failure
- Test: `flush()` drains all pending events
- Test: Concurrent pushes during processing are handled correctly

### T021 [DONE] [P] Unit tests for `LogBuffer` and `LogBufferManager`
**Files**: `packages/generacy/src/orchestrator/__tests__/log-buffer.test.ts`
- Test: `LogBuffer.append()` assigns monotonic IDs
- Test: `LogBuffer.getAll()` returns all entries
- Test: `LogBuffer.getAfterId()` returns entries after specified ID
- Test: Capacity eviction — oldest entries dropped when buffer is full
- Test: `LogBuffer.clear()` resets buffer and counter
- Test: `LogBufferManager.getOrCreate()` creates new buffer on first access
- Test: `LogBufferManager.get()` returns undefined for unknown jobs
- Test: `LogBufferManager.scheduleCleanup()` removes buffer after grace period
- Test: `LogBufferManager.destroy()` cleans up all timers and buffers

### T022 [DONE] [P] Unit tests for `EventBus` log routing
**Files**: `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts`
- Test: `log:append` events routed to `LogBufferManager` instead of `RingBuffer`
- Test: Lifecycle events still stored in per-job `RingBuffer`
- Test: SSE broadcast happens for both log and lifecycle events
- Test: `scheduleCleanup` also triggers `LogBufferManager.scheduleCleanup()`

### T023 [DONE] Integration test: end-to-end log streaming
**Files**: `packages/generacy/src/orchestrator/__tests__/log-streaming.integration.test.ts`
- Test: POST a `log:append` event → GET `/api/jobs/:jobId/logs` returns the entry
- Test: `?since=<id>` returns only newer entries
- Test: SSE subscriber receives `log:append` events in real-time
- Test: Log buffer cleanup after job completion grace period

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001) must complete before Phase 3 (T006-T010) — operations depend on `onStdout`/`onStderr` in `CommandOptions`
- Phase 2 (T002-T004) must complete before Phase 3 (T005-T010) — operations depend on `log:append` type, `emitEvent` in context, and `StreamBatcher`
- Phase 3 T005 must complete before T006-T010 — operations depend on `emitEvent` being wired in executor
- Phase 4 (T011) must complete before T012 — job handler depends on `AsyncEventQueue`
- Phase 5 T013 must complete before T014-T015 — server and event bus depend on `LogBuffer`/`LogBufferManager`
- Phase 6 (T016-T017) can start after their respective implementation phases
- Phase 7 (T018-T023) can start after their respective implementation phases

**Parallel opportunities within phases**:
- T002, T003, T004 are fully independent (different files, no dependencies)
- T006, T007, T008, T009, T010 are fully independent (different operation files, same pattern)
- T016, T017 are independent (different packages)
- T018-T023 are all independent test files

**Critical path**:
T001 → T002+T003+T004 → T005 → T006 → T011 → T012 → T013 → T014 → T015 → T017 → T023

---

*Generated by speckit*
