# Research & Technical Decisions

**Feature**: 176-orchestrator-add-sse-endpoint

## Clarification Resolutions

This document records the reasoning behind each clarification question decision.

### Q1: Event ID Format → Monotonic Counter (Option C)

**Chosen**: Per-job monotonic counter (`"1"`, `"2"`, `"42"`)

**Why not UUID (Option B)?** UUIDs are 36 characters, adding ~36 bytes per event on the wire. They require linear scan for replay since they're not ordered. No benefit from global uniqueness — event IDs are only meaningful within a job's buffer scope.

**Why not timestamp-sequence (Option A)?** More complex to generate correctly (need to handle same-millisecond events), larger than a simple integer, and the binary search benefit only matters if we had very large buffers. With a 1000-event cap, linear scan after offset calculation is fast enough.

**Why counter works**: Each job has its own ring buffer with its own counter. The counter starts at 1 and increments monotonically. When the ring buffer evicts old events, it tracks the `baseCounter` (the counter value of the oldest evicted event). To find events after a given ID: `index = requestedId - (currentCounter - bufferSize)`. This is O(1). For the global stream, we prefix with `{jobId}:` to ensure cross-job uniqueness.

### Q2: Auto-Publish on Status Update → Yes (Option A)

**Chosen**: `PUT /api/jobs/:jobId/status` automatically emits `job:status` events

**Key insight**: The `updateJobStatus` handler in `server.ts` already has access to both the old status (via `jobQueue.getJob()`) and the new status (from the request body). We can capture `previousStatus` before updating and emit the event after. This is a 5-line addition to an existing handler.

**Why not explicit only (Option B)?** Workers already call `updateJobStatus()` as part of their flow. Requiring them to also POST a separate event doubles the API calls and risks state/event drift if one fails.

**Why not both (Option C)?** Unnecessary complexity. If workers need to publish richer events, they can use `POST /api/jobs/:jobId/events` for custom event types. Auto-publish handles the common `job:status` case.

### Q3: EventBus Configuration → Moderate (Option B)

**Chosen**: Three options: `eventBufferSize`, `eventGracePeriod`, `sseHeartbeatInterval`

**Why not minimal (Option A)?** The grace period and heartbeat interval are genuinely useful tuning knobs. A production deployment behind an aggressive proxy might need a shorter heartbeat. A high-throughput system might want a shorter grace period to free memory faster.

**Why not full (Option C)?** `maxSubscribersPerJob` and `maxGlobalSubscribers` are premature. This is a single-process server where OS-level limits suffice. If connection limits become needed, they can be added without breaking changes.

### Q4: Global Stream Filter Matching → Filter at Broadcast (Option C)

**Chosen**: Look up job from queue at broadcast time to evaluate filters

**Why not lookup on subscribe (Option A)?** When a new job is created after the client subscribes, the client wouldn't see it unless we add a job-creation hook. Filter-at-broadcast naturally handles new jobs because every event triggers a filter check against current state.

**Why not enrich events (Option B)?** Adds `tags`, `workflow`, `status` to every event payload. This bloats events by ~100-200 bytes each, and most consumers already know the job context. It also means events carry stale data if the job's tags/status change after the event was emitted.

**Performance note**: For the global stream, each broadcast does a `jobQueue.getJob(jobId)` call. Since `InMemoryJobQueue.getJob()` is a synchronous `Map.get()`, this is ~O(1) and negligible even for high-frequency events.

### Q5: Stream Behavior for Terminal Jobs → Replay and Close (Option A)

**Chosen**: Send all buffered events, then close the stream

**Why not 410 Gone (Option B)?** A 410 provides no event data. The whole point of subscribing is to get event history. If the buffer exists, the client should get it.

**Why not keep open (Option C)?** A terminal job won't produce new events. Keeping the connection open until grace period cleanup wastes a connection for no benefit.

**Implementation detail**: After sending all buffered events, write a final SSE comment `: stream-closed\n\n` and call `res.end()`. The client's `EventSource` will attempt reconnection, but a subsequent request will return 404 (buffer cleaned up) or replay-and-close again (still in grace period).

### Q6: step:output Event Volume → No Special Handling (Option A)

**Chosen**: All events share the same ring buffer

**Why this is acceptable**: The primary consumers are VS Code extensions and dashboards that care about structural events (status, phase, step). If `step:output` events push structural events out of the buffer, that only affects reconnecting clients — live subscribers already received them in real-time. The `Last-Event-ID` contract states that if the requested ID is no longer in buffer, replay starts from the oldest available event.

**Future option**: If this becomes a problem, Option D (output bypasses buffer) is the cleanest upgrade path — it can be added without changing the API contract.

### Q7: Max Concurrent SSE Connections → No Enforced Limit (Option A)

**Chosen**: Rely on OS limits, log warnings at thresholds

**Warning thresholds** (logged at WARN level):
- Per-job: > 100 subscribers
- Global: > 500 total SSE connections

**Why not per-job or global limits?** Adds rejection handling complexity (503 responses, retry logic). The single-process orchestrator won't realistically hit OS limits in its intended use case (development tooling, small teams).

### Q8: Client subscribeEvents() Return Type → AsyncIterator (Option A)

**Chosen**: Return `AsyncIterable<JobEvent>`

**Usage pattern**:
```typescript
const events = client.subscribeEvents(jobId);
for await (const event of events) {
  console.log(event.type, event.data);
  if (event.type === 'job:status' && isTerminal(event.data.status)) {
    break; // Automatically cleans up connection
  }
}
```

**Why not callbacks (Option B)?** Callbacks require manual cleanup and don't compose well with async control flow. The `for await` pattern handles backpressure naturally and the cleanup-on-break semantic prevents resource leaks.

**Why not EventEmitter (Option C)?** EventEmitter is more complex to implement and type correctly. It also doesn't provide backpressure and requires explicit `removeAllListeners()` cleanup.

**Implementation detail**: Uses `ReadableStream` from the fetch response, wrapped in an `AsyncGenerator` that parses SSE frames and yields `JobEvent` objects. The `AbortController` is triggered on generator `return()` (break/early exit).

### Q9: POST Authorization → No Restriction (Option A)

**Chosen**: Any authenticated client can POST events

**The trust model is already established**: All clients share the same Bearer token. If a client has the token, they're trusted. The spec explicitly defers per-job authorization to a future issue.

### Q10: Job Status Sync → Events Are Passive (Option A)

**Chosen**: Events don't update job queue state

**Rationale**: Single source of truth for job state is the `JobQueue`. The auto-publish mechanism (Q2) ensures events reflect actual state changes. If events could also update state, we'd have two paths to state mutation, making the system harder to reason about and debug.

## SSE Implementation Notes

### Node.js Native SSE

SSE requires no special library with Node.js `http.ServerResponse`:

```typescript
res.writeHead(200, {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
});

// Send event
res.write(`event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);

// Send heartbeat
res.write(`: ping\n\n`);

// Close stream
res.end();
```

### Client-Side SSE Parsing

The `fetch()` API returns a `ReadableStream` body. For SSE parsing:

1. Read chunks from `response.body.getReader()`
2. Decode with `TextDecoder`
3. Split on `\n\n` (event boundaries)
4. Parse each event block for `event:`, `id:`, `data:` fields
5. Handle partial events at chunk boundaries (buffer incomplete frames)

### Connection Detection

`res.on('close', callback)` fires when:
- Client disconnects (closes browser tab, kills process)
- Network error severs the connection
- Client's `EventSource` reconnects (closes old connection first)

`res.write()` returns `false` if the write buffer is full (backpressure). For SSE, we can safely ignore this since events are small and the kernel TCP buffer handles flow control.

### Route Registration Order

The router matches sequentially. New routes must be ordered carefully:

```
GET /api/jobs/poll           ← specific path, no params
GET /api/jobs/:jobId/events  ← two segments after /jobs/
GET /api/jobs/:jobId         ← one segment after /jobs/ (catch-all)
POST /api/jobs/:jobId/events ← POST method, won't conflict with GET
POST /api/jobs/:jobId/result ← existing POST routes
```

The key insight: `/api/jobs/:jobId/events` has a literal `events` suffix, so it won't match just `/api/jobs/someid`. But `/api/jobs/:jobId` would match `/api/jobs/someid/events` only if the regex captures the rest — and since `pathToRegex` produces `^/api/jobs/([^/]+)$` (note the `$` anchor), it won't match `/api/jobs/someid/events`. So ordering is safe, but for clarity, we register more-specific routes first.

---

*Generated by speckit*
