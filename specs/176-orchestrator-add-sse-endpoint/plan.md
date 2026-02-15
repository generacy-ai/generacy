# Implementation Plan: Orchestrator SSE Endpoint for Real-Time Job Event Streaming

**Feature**: 176-orchestrator-add-sse-endpoint
**Date**: 2026-02-15
**Status**: Draft

## Summary

Add Server-Sent Events (SSE) streaming to the orchestrator so clients can subscribe to real-time job events without polling. This involves creating an `EventBus` module with per-job ring buffers, adding three new HTTP endpoints (two SSE streams + one POST for event ingestion), and extending the existing client with streaming support. The implementation uses only Node.js built-in APIs, consistent with the existing zero-dependency orchestrator architecture.

## Technical Context

| Aspect | Detail |
|--------|--------|
| **Language** | TypeScript (strict mode) |
| **Runtime** | Node.js (native `http` module, no framework) |
| **Test Framework** | Vitest |
| **Package Manager** | pnpm |
| **Module System** | ESM (`.js` extensions in imports) |
| **Dependencies** | None new — SSE is native HTTP streaming via `res.write()` |

### Key Codebase Conventions
- Routes defined via `pathToRegex()` + `createRouter()` in `server.ts`
- Handlers are async functions `(req, res, params) => Promise<void>`
- JSON responses via `sendJson()` / `sendError()` helpers
- Auth via Bearer token checked in request handler
- All interfaces exported from `index.ts`
- Tests use `createOrchestratorServer({ port: 0 })` for ephemeral ports

## Architecture Overview

```
┌─────────────┐     POST /api/jobs/:id/events     ┌──────────────┐
│   Workers    │ ─────────────────────────────────→ │              │
└─────────────┘                                     │              │
                                                    │  EventBus    │
┌─────────────┐     GET /api/jobs/:id/events       │              │
│  VS Code    │ ←─────────────── SSE ──────────── │  - buffers   │
│  Extension  │                                     │  - publish() │
└─────────────┘                                     │  - subscribe │
                                                    │              │
┌─────────────┐     GET /api/events                │              │
│  Dashboard  │ ←─────────────── SSE ──────────── │              │
└─────────────┘                                     └──────┬───────┘
                                                           │
                    PUT /api/jobs/:id/status                │ auto-publish
                    ───────────────────────────────────────→│
                    (existing endpoint, now emits events)
```

### Component Interactions

1. **Workers** POST events to `POST /api/jobs/:jobId/events` during job execution
2. **EventBus** buffers events in per-job ring buffers and broadcasts to SSE subscribers
3. **SSE Clients** connect via `GET /api/jobs/:jobId/events` (single job) or `GET /api/events` (all jobs)
4. **Status Updates** via existing `PUT /api/jobs/:jobId/status` auto-emit `job:status` events
5. **Reconnection** via `Last-Event-ID` header replays missed events from ring buffer

## Key Technical Decisions

### D1: Event ID Format — Monotonic Counter (Option C)

**Decision**: Use per-job monotonic counter format `{counter}` (e.g., `1`, `2`, `42`).

**Rationale**: Per-job counters are the simplest and most compact format. Since each job has its own ring buffer, the counter is scoped to that buffer. O(1) lookup by offset (counter minus the ring buffer's base offset). No UUID generation overhead, no timestamp parsing needed. For the global stream, event IDs are prefixed with jobId: `{jobId}:{counter}` to maintain uniqueness.

### D2: Auto-Publish on Status Update (Option A)

**Decision**: `PUT /api/jobs/:jobId/status` automatically emits `job:status` events on the EventBus.

**Rationale**: This keeps events in sync with actual job state. Workers don't need to double-post status changes. The auto-published event includes `{ status, previousStatus }` derived from the state transition. Workers can still POST richer events explicitly if needed (e.g., with additional metadata).

### D3: EventBus Configuration (Option B — Moderate)

**Decision**: Expose three configuration options in `OrchestratorServerOptions`:
- `eventBufferSize` (default: 1000)
- `eventGracePeriod` (default: 300000 / 5 minutes)
- `sseHeartbeatInterval` (default: 30000 / 30 seconds)

**Rationale**: These are the three main tuning knobs that operators need. Buffer size affects memory, grace period affects how long terminated jobs remain replayable, heartbeat interval affects proxy compatibility. More advanced settings like max subscribers can be hardcoded constants since this is a single-process server.

### D4: Global Stream Filter Matching (Option C — Filter at Broadcast)

**Decision**: Evaluate filters at broadcast time by looking up job metadata from the job queue.

**Rationale**: This uses the most current job state for filter evaluation (a job's status can change). The EventBus receives the `jobId` with each event, so it can look up the job from the queue. The slight overhead per-event is negligible for a single-process server. This avoids denormalizing job metadata into every event (keeping payloads lean) and avoids complex subscription management when new jobs are created.

### D5: Stream Behavior for Terminal Jobs (Option A — Replay and Close)

**Decision**: When subscribing to a job already in terminal state (within grace period), send all buffered events then close the stream. Return 404 if the job doesn't exist or the buffer has been cleaned up.

**Rationale**: Clients subscribing to a completed job want the event history. Sending buffered events and immediately closing gives them the data without wasting a connection. The grace period ensures this works for a reasonable time after completion.

### D6: step:output Event Volume (Option A — No Special Handling)

**Decision**: All events share the same ring buffer. No special treatment for `step:output` events.

**Rationale**: The simplest approach. If verbose output pushes older events out of the buffer, `Last-Event-ID` reconnection may miss some events — but this is acceptable because: (1) output events are ephemeral by nature, (2) the structural events (status, phase, step) are what matter most for UI, and (3) batching or separate buffers add significant complexity for a v1 feature. Can be revisited if buffer saturation becomes a real problem.

### D7: Max Concurrent SSE Connections (Option A — No Enforced Limit)

**Decision**: No application-level connection limit. Rely on OS file descriptor limits. Log warnings when subscriber count exceeds a threshold (e.g., 100 per job, 500 total).

**Rationale**: This is a single-process orchestrator intended for development/small-scale use. OS-level limits are sufficient. Adding connection caps adds complexity and requires deciding on rejection behavior. Warning logs give operators visibility without blocking legitimate connections.

### D8: Client subscribeEvents() Return Type (Option A — AsyncIterator)

**Decision**: Return `AsyncIterable<JobEvent>` that yields events. Cleanup on break/return.

**Rationale**: Most idiomatic for Node.js consumers. Works naturally with `for await...of` loops. The client internally uses `fetch()` with a streaming body reader and transforms chunks into parsed `JobEvent` objects. Cleanup (aborting the connection) happens automatically when the iterator is broken out of.

### D9: POST Authorization (Option A — No Restriction)

**Decision**: Any authenticated client can POST events to any job.

**Rationale**: Matches the current trust model. All clients use the same Bearer token. Adding per-job authorization requires changes to the auth system that are out of scope. The spec explicitly calls this out as a future enhancement.

### D10: Job Status Sync (Option A — Events Are Passive)

**Decision**: Events posted via `POST /api/jobs/:jobId/events` are informational only. They don't update job queue state.

**Rationale**: Job state is managed exclusively through the existing `PUT /api/jobs/:jobId/status` and `POST /api/jobs/:jobId/result` endpoints. This keeps a single source of truth for job state. Auto-publish (D2) ensures that status changes generate events, so the event stream stays in sync with actual state. Workers already update status through existing endpoints as part of their execution flow.

## Implementation Phases

### Phase 1: Core Types and Ring Buffer

**Goal**: Define all new types and implement the ring buffer data structure.

**Files**:
- `packages/generacy/src/orchestrator/types.ts` — Add `JobEventType`, `JobEvent`, `EventFilters`, `SSEConnectionInfo`

**New Types**:
```typescript
// Event types
type JobEventType =
  | 'job:status' | 'phase:start' | 'phase:complete'
  | 'step:start' | 'step:complete' | 'step:output'
  | 'action:error' | 'log:append';

// Event structure
interface JobEvent {
  id: string;                        // Monotonic counter (per-job)
  type: JobEventType;
  timestamp: number;                 // Unix epoch ms
  jobId: string;
  data: Record<string, unknown>;
}

// Filters for global stream
interface EventFilters {
  tags?: string[];
  workflow?: string;
  status?: JobStatus[];
}
```

**Ring Buffer** (implemented in `event-bus.ts`):
- Generic `RingBuffer<T>` class with fixed capacity
- Methods: `push(item)`, `getAll()`, `getAfter(predicate)`, `size`, `clear()`
- O(1) write, O(n) read for replay
- Tracks a base counter for efficient ID-based lookup

### Phase 2: EventBus Module

**Goal**: Implement the core EventBus with publish/subscribe/replay functionality.

**Files**:
- `packages/generacy/src/orchestrator/event-bus.ts` — **New file**

**EventBus Class**:
```typescript
interface EventBusOptions {
  bufferSize?: number;           // default: 1000
  gracePeriod?: number;          // default: 300000 (5 min)
  heartbeatInterval?: number;    // default: 30000 (30s)
  jobQueue: JobQueue;            // Required for filter evaluation
  logger?: Logger;
}
```

**Key Methods**:
- `publish(jobId: string, event: Omit<JobEvent, 'id'>): JobEvent` — Assign ID, buffer, broadcast
- `subscribe(jobId: string, res: ServerResponse, lastEventId?: string): void` — Add per-job subscriber, replay if needed
- `subscribeAll(res: ServerResponse, filters: EventFilters, lastEventId?: string): void` — Global subscriber
- `unsubscribe(res: ServerResponse): void` — Remove subscriber (called on connection close)
- `scheduleCleanup(jobId: string): void` — Start grace period timer for terminal jobs
- `startHeartbeat(): void` / `stopHeartbeat(): void` — Manage heartbeat interval
- `destroy(): void` — Clean up all timers and connections

**SSE Wire Format Helper**:
```typescript
function formatSSE(event: JobEvent): string {
  return `event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
}
```

**Connection Management**:
- Each SSE connection tracked in a `Set<ServerResponse>`
- On `res.on('close', ...)` → remove from subscriber sets
- Heartbeat sends `: ping\n\n` comment line every 30 seconds to all active connections
- When job reaches terminal state → send terminal event, schedule cleanup, close all per-job subscribers after sending

### Phase 3: Server Route Integration

**Goal**: Add the three new endpoints to `server.ts` and wire up auto-publish on status changes.

**Files**:
- `packages/generacy/src/orchestrator/server.ts` — Add routes, handlers, EventBus instantiation

**Changes to `createOrchestratorServer()`**:

1. **New options** on `OrchestratorServerOptions`:
   ```typescript
   eventBufferSize?: number;     // default: 1000
   eventGracePeriod?: number;    // default: 300000
   sseHeartbeatInterval?: number; // default: 30000
   ```

2. **Instantiate EventBus** alongside WorkerRegistry and JobQueue:
   ```typescript
   const eventBus = new EventBus({
     bufferSize: eventBufferSize,
     gracePeriod: eventGracePeriod,
     heartbeatInterval: sseHeartbeatInterval,
     jobQueue,
     logger,
   });
   ```

3. **Three new routes** (registered before the generic `GET /api/jobs/:jobId` route to avoid conflict):
   - `GET /api/jobs/:jobId/events` → `subscribeJobEvents`
   - `GET /api/events` → `subscribeAllEvents`
   - `POST /api/jobs/:jobId/events` → `publishEvent`

4. **Route ordering consideration**: The route `GET /api/jobs/:jobId/events` must be registered **before** `GET /api/jobs/:jobId` in the router, since the router matches sequentially and `:jobId` would otherwise capture `poll` and other sub-paths. Actually, the existing code already has `/api/jobs/poll` before `/api/jobs/:jobId`, so `events` routes follow the same pattern — paths with more segments come first.

5. **Handler: `subscribeJobEvents`**:
   ```
   - Validate jobId exists (404 if not)
   - Check if job is in terminal state
     - If terminal + buffer exists → replay buffered events, close stream
     - If terminal + no buffer → 404
   - Set SSE headers: Content-Type, Cache-Control, Connection
   - Parse Last-Event-ID from request headers
   - Call eventBus.subscribe(jobId, res, lastEventId)
   - On res close → eventBus.unsubscribe(res)
   ```

6. **Handler: `subscribeAllEvents`**:
   ```
   - Parse query params: tags, workflow, status
   - Set SSE headers
   - Parse Last-Event-ID
   - Call eventBus.subscribeAll(res, filters, lastEventId)
   - On res close → eventBus.unsubscribe(res)
   ```

7. **Handler: `publishEvent`**:
   ```
   - Validate jobId exists (404 if not)
   - Parse JSON body, validate type and data fields (400 if missing)
   - Construct JobEvent with timestamp and jobId
   - Call eventBus.publish(jobId, event)
   - If event type is job:status with terminal status → schedule cleanup
   - Return 201 with { eventId }
   ```

8. **Modify existing `updateJobStatus` handler**: After `jobQueue.updateStatus()`, auto-publish a `job:status` event:
   ```typescript
   eventBus.publish(jobId, {
     type: 'job:status',
     timestamp: Date.now(),
     jobId,
     data: { status: body.status, previousStatus: job.status },
   });
   // If terminal → schedule cleanup + close streams
   if (['completed', 'failed', 'cancelled'].includes(body.status)) {
     eventBus.scheduleCleanup(jobId);
   }
   ```

9. **Expose EventBus on `OrchestratorServer` interface**:
   ```typescript
   interface OrchestratorServer {
     // ... existing methods
     getEventBus(): EventBus;
   }
   ```

10. **Server close**: Call `eventBus.destroy()` during server shutdown to clean up heartbeat timers and connections.

### Phase 4: Client Extension

**Goal**: Add `subscribeEvents()` and `publishEvent()` to `OrchestratorClient`.

**Files**:
- `packages/generacy/src/orchestrator/client.ts` — Add two new methods

**`publishEvent(jobId, event)`**:
- Standard POST request to `/api/jobs/${jobId}/events`
- Returns `{ eventId: string }`

**`subscribeEvents(jobId, options?)`**:
- Returns `AsyncIterable<JobEvent>` implemented via `AsyncGenerator`
- Uses native `fetch()` with streaming response body
- Passes `Last-Event-ID` header if `options.lastEventId` is provided
- Internally reads the response body as a stream, parsing SSE frames
- AbortController for cleanup on iterator return/break

**`subscribeAllEvents(options?)`**:
- Same pattern as `subscribeEvents` but hits `GET /api/events` with filter query params
- Accepts `filters?: EventFilters` in options

**SSE Parsing** (private helper):
- Parse SSE text stream into structured events
- Handle `event:`, `id:`, `data:` fields
- Skip heartbeat comments (lines starting with `:`)
- Yield parsed `JobEvent` objects

### Phase 5: Module Exports

**Goal**: Export all new public types and the EventBus class.

**Files**:
- `packages/generacy/src/orchestrator/index.ts` — Add exports

**New exports**:
```typescript
export { EventBus } from './event-bus.js';
export type { EventBusOptions } from './event-bus.js';
export type { JobEventType, JobEvent, EventFilters } from './types.js';
```

### Phase 6: Unit Tests — EventBus and RingBuffer

**Goal**: Thorough unit testing of the EventBus module in isolation.

**Files**:
- `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts` — **New file**

**Test Cases**:

**RingBuffer**:
- Stores items up to capacity
- Evicts oldest items when full (ring behavior)
- `getAll()` returns items in insertion order
- `getAfter(id)` returns items after a given event ID
- `clear()` empties the buffer
- Edge cases: empty buffer, single item, exactly at capacity

**EventBus — Publishing**:
- `publish()` assigns monotonically increasing IDs per job
- Published events are buffered in the correct job's ring buffer
- Events are broadcast to per-job subscribers
- Events are broadcast to global subscribers (with filter matching)
- Global subscribers with non-matching filters don't receive events

**EventBus — Subscribing**:
- New subscriber receives no events until publish
- Subscriber with `lastEventId` receives replayed events in order
- Subscriber with unknown `lastEventId` receives all buffered events
- Multiple subscribers on same job all receive events
- Unsubscribe removes subscriber from set

**EventBus — Cleanup**:
- `scheduleCleanup()` removes buffer after grace period
- Cleanup timer is cleared if job gets new events (shouldn't happen for terminal)
- `destroy()` clears all timers and subscriber sets

**EventBus — Heartbeat**:
- Heartbeat comment sent to all active connections at configured interval

**EventBus — Filter Evaluation**:
- Tags filter matches jobs with matching tags
- Workflow filter matches job workflow name
- Status filter matches current job status
- Multiple filters combine with AND logic

### Phase 7: Integration Tests — SSE Endpoints

**Goal**: End-to-end testing of SSE endpoints through the HTTP server.

**Files**:
- `packages/generacy/src/orchestrator/__tests__/server.test.ts` — Add new test blocks

**Test Cases**:

**GET /api/jobs/:jobId/events**:
- Returns `Content-Type: text/event-stream`
- Returns 404 for non-existent job
- Receives events after worker POSTs them
- `Last-Event-ID` triggers replay of buffered events
- Stream auto-closes on terminal job status
- Replay-and-close for already-terminal jobs

**GET /api/events**:
- Returns SSE stream with events from all jobs
- Filters by tags (only matching job events delivered)
- Filters by workflow name
- Filters by status
- Multiple filters combine with AND

**POST /api/jobs/:jobId/events**:
- Returns 201 with eventId on success
- Returns 404 for non-existent job
- Returns 400 for missing type or data fields
- Published event appears in SSE stream
- Requires authentication

**Auto-publish on status update**:
- `PUT /api/jobs/:jobId/status` emits `job:status` event to SSE stream
- Terminal status triggers stream close

**SSE Format Verification**:
- Events include `event:` field matching type
- Events include `id:` field
- Events include `data:` field with JSON payload
- Heartbeat pings are sent as comments

## SSE Response Headers

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

The `X-Accel-Buffering: no` header prevents nginx from buffering the response.

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Memory growth from many concurrent jobs | Ring buffer caps at configurable size; cleanup timer evicts buffers after grace period; EventBus tracks total buffer count for monitoring |
| Stale SSE connections from crashed clients | `res.on('close')` listener removes subscriber; heartbeat pings detect dead connections via write errors |
| Proxy/LB dropping idle connections | 30-second heartbeat interval; `X-Accel-Buffering: no` header |
| Route ordering conflicts | New SSE routes registered before generic `:jobId` catch-all; covered by integration tests |
| Event ID replay misses | If buffer wraps and requested ID is gone, replay from oldest buffered event (documented behavior) |
| Test flakiness with SSE timing | Use deterministic event publishing in tests; collect events via readable stream with timeout |

## File Change Summary

| File | Action | Description |
|------|--------|-------------|
| `types.ts` | Modify | Add `JobEventType`, `JobEvent`, `EventFilters` types |
| `event-bus.ts` | Create | `EventBus` class, `RingBuffer` class, SSE helpers |
| `server.ts` | Modify | Add 3 routes, 3 handlers, EventBus instantiation, auto-publish hook, `getEventBus()` |
| `client.ts` | Modify | Add `publishEvent()`, `subscribeEvents()`, `subscribeAllEvents()` methods |
| `index.ts` | Modify | Re-export `EventBus`, `EventBusOptions`, `JobEventType`, `JobEvent`, `EventFilters` |
| `__tests__/event-bus.test.ts` | Create | Unit tests for RingBuffer and EventBus |
| `__tests__/server.test.ts` | Modify | Integration tests for SSE endpoints |

## Dependencies

- **No new npm dependencies**. SSE is implemented using Node.js built-in `http.ServerResponse.write()`.
- `EventBus` depends on `JobQueue` interface for filter evaluation (injected via constructor).

---

*Generated by speckit*
