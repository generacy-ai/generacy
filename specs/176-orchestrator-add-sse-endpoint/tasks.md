# Tasks: Orchestrator SSE Endpoint for Real-Time Job Event Streaming

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Core Types and Ring Buffer

### T001 [US1,US2,US3] Add SSE event types to `types.ts`
**File**: `packages/generacy/src/orchestrator/types.ts`
- Add `JobEventType` union type: `'job:status' | 'phase:start' | 'phase:complete' | 'step:start' | 'step:complete' | 'step:output' | 'action:error' | 'log:append'`
- Add `JobEvent` interface with fields: `id` (string), `type` (JobEventType), `timestamp` (number), `jobId` (string), `data` (Record<string, unknown>)
- Add `EventFilters` interface with optional fields: `tags` (string[]), `workflow` (string), `status` (JobStatus[])

### T002 [P] [US4] Implement `RingBuffer` class in `event-bus.ts`
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Create generic `RingBuffer<T>` class with configurable capacity (default 1000)
- Implement `push(item: T)` — O(1) write using circular array, evicts oldest when full
- Implement `getAll(): T[]` — returns all items in insertion order
- Implement `getAfterIndex(startIndex: number): T[]` — returns items after a given buffer-relative index (for `Last-Event-ID` replay)
- Track `baseIndex` (number of items ever evicted) so event IDs can be mapped to buffer positions
- Implement `size` getter, `capacity` getter, and `clear()` method
- Export `RingBuffer` class for unit testing

---

## Phase 2: EventBus Module

### T003 [US1,US3] Implement `EventBus` core — publish and per-job subscribe
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Define `EventBusOptions` interface: `bufferSize?` (number), `gracePeriod?` (number, ms), `heartbeatInterval?` (number, ms), `jobQueue` (JobQueue), `logger?`
- Create `EventBus` class with internal state:
  - `buffers: Map<string, RingBuffer<JobEvent>>` — per-job ring buffers
  - `counters: Map<string, number>` — per-job monotonic ID counters
  - `subscribers: Map<string, Set<ServerResponse>>` — per-job SSE connections
  - `globalSubscribers: Set<{ res: ServerResponse; filters: EventFilters }>` — global stream connections
  - `cleanupTimers: Map<string, NodeJS.Timeout>` — grace period timers
- Implement `publish(jobId: string, event: Omit<JobEvent, 'id'>): JobEvent`
  - Assign monotonic ID from per-job counter (format: string of the counter number)
  - Create or reuse per-job ring buffer
  - Buffer the event
  - Broadcast to per-job subscribers via `res.write(formatSSE(event))`
  - Broadcast to matching global subscribers (filter evaluation deferred to T004)
- Implement `subscribe(jobId: string, res: ServerResponse, lastEventId?: string): void`
  - Add `res` to per-job subscriber set
  - If `lastEventId` provided, replay buffered events after that ID
  - If `lastEventId` not found in buffer, replay all buffered events
  - Register `res.on('close', ...)` to auto-unsubscribe
- Implement `unsubscribe(res: ServerResponse): void`
  - Remove `res` from all subscriber sets (per-job and global)
- Implement private `formatSSE(event: JobEvent): string` helper
  - Format: `event: {type}\nid: {id}\ndata: {json}\n\n`

### T004 [US2] Implement `EventBus` global subscribe with filter matching
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Implement `subscribeAll(res: ServerResponse, filters: EventFilters, lastEventId?: string): void`
  - Add to `globalSubscribers` set with filters
  - If `lastEventId` provided (format `{jobId}:{counter}`), parse jobId and replay from that job's buffer, then replay other buffers
  - Register `res.on('close', ...)` to auto-unsubscribe
- Implement filter matching in `publish()` broadcast:
  - Look up job from `jobQueue.getJob(jobId)` to get current job metadata
  - Match `filters.tags` — job must have at least one matching tag (if filter specified)
  - Match `filters.workflow` — job's workflow must match (string comparison)
  - Match `filters.status` — job's current status must be in filter list
  - All specified filters combine with AND logic
  - Skip broadcast to subscribers whose filters don't match

### T005 [US1] Implement `EventBus` terminal state handling and cleanup
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Implement `scheduleCleanup(jobId: string): void`
  - After grace period (default 5 min), delete the job's ring buffer, counter, and subscriber set
  - Clear any existing timer for the job before setting a new one
- Implement `closeJobSubscribers(jobId: string): void`
  - Send final event then call `res.end()` on all per-job subscribers
  - Remove all per-job subscribers from the set
- Implement `getBufferedEvents(jobId: string): JobEvent[]`
  - Return all events from a job's ring buffer (for replay-and-close on terminal jobs)

### T006 [US1,US2] Implement SSE heartbeat mechanism
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Implement `startHeartbeat(): void` — sets interval to send `: ping\n\n` to all active SSE connections
- Implement `stopHeartbeat(): void` — clears the heartbeat interval
- Heartbeat interval configurable (default 30s)
- On write error during heartbeat, clean up the dead connection (call `unsubscribe`)

### T007 Implement `EventBus.destroy()` for clean shutdown
**File**: `packages/generacy/src/orchestrator/event-bus.ts`
- Stop heartbeat interval
- Clear all cleanup timers
- Close all SSE connections (`res.end()` on all subscribers)
- Clear all internal maps

---

## Phase 3: Server Route Integration

### T008 [US1,US2,US3] Add SSE configuration options to `OrchestratorServerOptions`
**File**: `packages/generacy/src/orchestrator/server.ts`
- Add `eventBufferSize?: number` (default: 1000) to `OrchestratorServerOptions`
- Add `eventGracePeriod?: number` (default: 300000) to `OrchestratorServerOptions`
- Add `sseHeartbeatInterval?: number` (default: 30000) to `OrchestratorServerOptions`

### T009 [US1,US2,US3] Instantiate `EventBus` and wire into server lifecycle
**File**: `packages/generacy/src/orchestrator/server.ts`
- Import `EventBus` from `./event-bus.js`
- Instantiate `EventBus` in `createOrchestratorServer()` with options from `OrchestratorServerOptions`
- Pass `jobQueue` to EventBus constructor
- Call `eventBus.startHeartbeat()` after server starts listening
- Call `eventBus.destroy()` in `close()` method before closing HTTP server
- Add `getEventBus(): EventBus` to `OrchestratorServer` interface and implementation

### T010 [US1] Add `GET /api/jobs/:jobId/events` SSE route handler
**File**: `packages/generacy/src/orchestrator/server.ts`
- Register route `GET /api/jobs/:jobId/events` **before** `GET /api/jobs/:jobId` in the router
- Implement `subscribeJobEvents` handler:
  - Validate `jobId` exists via `jobQueue.getJob()`, return 404 if not
  - Check if job is in terminal state (`completed`, `failed`, `cancelled`):
    - If terminal and buffer exists → replay all buffered events, then `res.end()`
    - If terminal and no buffer → return 404
  - Set SSE response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
  - Call `res.writeHead(200)` with headers, then `res.flushHeaders()`
  - Parse `Last-Event-ID` from `req.headers['last-event-id']`
  - Call `eventBus.subscribe(jobId, res, lastEventId)`

### T011 [US2] Add `GET /api/events` global SSE route handler
**File**: `packages/generacy/src/orchestrator/server.ts`
- Register route `GET /api/events` in the router
- Implement `subscribeAllEvents` handler:
  - Parse query parameters: `tags` (comma-separated → string[]), `workflow` (string), `status` (comma-separated → JobStatus[])
  - Construct `EventFilters` object from parsed params
  - Set SSE response headers (same as T010)
  - Call `res.writeHead(200)` with headers, then `res.flushHeaders()`
  - Parse `Last-Event-ID` from request headers
  - Call `eventBus.subscribeAll(res, filters, lastEventId)`

### T012 [US3] Add `POST /api/jobs/:jobId/events` event publish route handler
**File**: `packages/generacy/src/orchestrator/server.ts`
- Register route `POST /api/jobs/:jobId/events` in the router (can share the same pathToRegex as the GET SSE route since methods differ)
- Implement `publishEvent` handler:
  - Validate `jobId` exists via `jobQueue.getJob()`, return 404 if not
  - Parse JSON body via `parseJsonBody()`
  - Validate `type` field exists and is a valid `JobEventType`, return 400 if missing
  - Validate `data` field exists and is an object, return 400 if missing
  - Construct event: `{ type: body.type, timestamp: body.timestamp ?? Date.now(), jobId, data: body.data }`
  - Call `eventBus.publish(jobId, event)`
  - If `type === 'job:status'` and `data.status` is terminal → call `eventBus.scheduleCleanup(jobId)` and `eventBus.closeJobSubscribers(jobId)`
  - Return 201 with `{ eventId: publishedEvent.id }`

### T013 [US1] Add auto-publish `job:status` events on status updates
**File**: `packages/generacy/src/orchestrator/server.ts`
- Modify existing `updateJobStatus` handler:
  - After successful `jobQueue.updateStatus()`, get the previous status from the job object fetched earlier
  - Call `eventBus.publish(jobId, { type: 'job:status', timestamp: Date.now(), jobId, data: { status: body.status, previousStatus: previousStatus } })`
  - If new status is terminal (`completed`, `failed`, `cancelled`) → call `eventBus.closeJobSubscribers(jobId)` then `eventBus.scheduleCleanup(jobId)`
- Modify existing `cancelJob` handler:
  - After successful `jobQueue.cancelJob()`, auto-publish `job:status` event with `{ status: 'cancelled', previousStatus }`
  - Call `eventBus.closeJobSubscribers(jobId)` and `eventBus.scheduleCleanup(jobId)`

---

## Phase 4: Client Extension

### T014 [P] [US3] Add `publishEvent()` method to `OrchestratorClient`
**File**: `packages/generacy/src/orchestrator/client.ts`
- Import `JobEvent`, `JobEventType` from `./types.js`
- Add method `publishEvent(jobId: string, event: { type: JobEventType; data: Record<string, unknown>; timestamp?: number }): Promise<{ eventId: string }>`
  - POST to `/api/jobs/${jobId}/events` using existing `request()` method
  - Return `{ eventId }` from response

### T015 [P] [US1] Add `subscribeEvents()` method to `OrchestratorClient`
**File**: `packages/generacy/src/orchestrator/client.ts`
- Add method `subscribeEvents(jobId: string, options?: { lastEventId?: string; signal?: AbortSignal }): AsyncIterable<JobEvent>`
  - Use `fetch()` to connect to `GET /api/jobs/${jobId}/events` with streaming response
  - Pass `Last-Event-ID` header if `options.lastEventId` provided
  - Return an `AsyncGenerator` that yields parsed `JobEvent` objects
  - Implement internal SSE line parser: handle `event:`, `id:`, `data:` fields, skip `: ` comment lines (heartbeats)
  - Support cancellation via `AbortSignal` or generator `.return()`

### T016 [P] [US2] Add `subscribeAllEvents()` method to `OrchestratorClient`
**File**: `packages/generacy/src/orchestrator/client.ts`
- Import `EventFilters` from `./types.js`
- Add method `subscribeAllEvents(options?: { filters?: EventFilters; lastEventId?: string; signal?: AbortSignal }): AsyncIterable<JobEvent>`
  - Build query string from filters: `tags` (comma-separated), `workflow`, `status` (comma-separated)
  - Use `fetch()` to connect to `GET /api/events?{queryString}` with streaming response
  - Reuse the SSE parsing logic from T015 (extract to a private helper `parseSSEStream`)
  - Return `AsyncGenerator<JobEvent>`

---

## Phase 5: Module Exports

### T017 [US1,US2,US3] Update `index.ts` with new exports
**File**: `packages/generacy/src/orchestrator/index.ts`
- Add `export { EventBus } from './event-bus.js'`
- Add `export type { EventBusOptions } from './event-bus.js'`
- Add `export type { JobEventType, JobEvent, EventFilters } from './types.js'`

---

## Phase 6: Unit Tests — EventBus and RingBuffer

### T018 [P] Write `RingBuffer` unit tests
**File**: `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts`
- Test: stores items up to capacity and returns in insertion order
- Test: evicts oldest items when buffer exceeds capacity (ring behavior)
- Test: `getAfterIndex()` returns items after a given buffer-relative index
- Test: `getAfterIndex()` with index before buffer start returns all buffered items
- Test: `clear()` empties the buffer and resets state
- Test: edge cases — empty buffer returns empty array, single item, exactly at capacity boundary

### T019 [P] Write `EventBus` publish and subscribe unit tests
**File**: `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts`
- Test: `publish()` assigns monotonically increasing string IDs per job (`"1"`, `"2"`, `"3"`, ...)
- Test: published events are buffered in the correct job's ring buffer
- Test: published events are broadcast to per-job subscribers via `res.write()`
- Test: multiple subscribers on the same job all receive events
- Test: subscriber receives no events until something is published
- Test: `unsubscribe()` removes subscriber from set, no further events received
- Use mock `ServerResponse` objects with `write()` and `on()` stubs

### T020 [P] Write `EventBus` replay and `Last-Event-ID` unit tests
**File**: `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts`
- Test: subscriber with `lastEventId` receives replayed events in order after that ID
- Test: subscriber with unknown/expired `lastEventId` receives all buffered events
- Test: replay events are sent before new live events
- Test: global subscriber `lastEventId` with `{jobId}:{counter}` format replays correctly

### T021 [P] Write `EventBus` filter, cleanup, and heartbeat unit tests
**File**: `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts`
- Test: global subscriber with `tags` filter only receives matching job events
- Test: global subscriber with `workflow` filter only receives matching events
- Test: global subscriber with `status` filter only receives matching events
- Test: multiple filters combine with AND logic
- Test: `scheduleCleanup()` removes buffer after grace period (use `vi.advanceTimersByTime`)
- Test: `destroy()` clears all timers, subscriber sets, and buffers
- Test: heartbeat sends `: ping\n\n` to all active connections at configured interval
- Test: dead connection detected during heartbeat triggers cleanup

---

## Phase 7: Integration Tests — SSE Endpoints

### T022 Write integration tests for `GET /api/jobs/:jobId/events`
**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Test: returns `Content-Type: text/event-stream` header
- Test: returns 404 for non-existent job
- Test: receives events after worker POSTs them to `POST /api/jobs/:jobId/events`
- Test: `Last-Event-ID` header triggers replay of buffered events before live events
- Test: stream auto-closes when job reaches terminal status (via `PUT /api/jobs/:jobId/status`)
- Test: subscribing to already-terminal job replays buffered events then closes
- Test: SSE events include `event:` field matching the event type
- Test: SSE events include `id:` field with monotonic counter
- Use `fetch()` with streaming body reader; parse SSE frames from response stream with timeout

### T023 [P] Write integration tests for `GET /api/events`
**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Test: returns SSE stream with events from multiple jobs
- Test: `tags` filter only delivers events for matching jobs
- Test: `workflow` filter only delivers events for matching workflow
- Test: `status` filter only delivers events for matching job status
- Test: multiple filters combine with AND logic
- Test: new jobs automatically appear in the stream without reconnection

### T024 [P] Write integration tests for `POST /api/jobs/:jobId/events`
**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Test: returns 201 with `{ eventId }` on success
- Test: returns 404 for non-existent job
- Test: returns 400 for missing `type` field
- Test: returns 400 for missing `data` field
- Test: published event appears in an active SSE stream for that job
- Test: requires authentication when auth is enabled

### T025 Write integration tests for auto-publish on status update
**File**: `packages/generacy/src/orchestrator/__tests__/server.test.ts`
- Test: `PUT /api/jobs/:jobId/status` emits `job:status` event to SSE stream with `{ status, previousStatus }`
- Test: terminal status via `PUT` triggers stream close for per-job subscribers
- Test: `POST /api/jobs/:jobId/cancel` emits `job:status` event with cancelled status

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001, T002) must complete before Phase 2
- Phase 2 (T003–T007) must complete before Phase 3
- Phase 3 (T008–T013) must complete before Phase 7 integration tests
- Phase 4 (T014–T016) depends on Phase 1 types only, can run in parallel with Phases 2–3
- Phase 5 (T017) depends on Phases 2 and 4
- Phase 6 (T018–T021) depends on Phase 2
- Phase 7 (T022–T025) depends on Phase 3

**Parallel opportunities within phases**:
- T001 and T002 can run in parallel (different files, no dependency)
- T014, T015, T016 can all run in parallel (same file but independent methods)
- T018, T019, T020, T021 can all run in parallel (independent test suites in same file)
- T022, T023, T024 can run in parallel (independent test blocks)

**Critical path**:
T001 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T013 → T022 → T025
