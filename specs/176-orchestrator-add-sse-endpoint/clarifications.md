# Clarification Questions

## Status: Pending

## Questions

### Q1: Event ID Format
**Context**: The spec lists two options for event IDs (`evt-{uuid}` vs `{timestamp}-{sequence}`) but doesn't pick one. The choice affects replay correctness, ID size in the wire format, and whether IDs are sortable. A timestamp-based approach enables efficient binary search during `Last-Event-ID` replay, while UUIDs are simpler but require linear scans.
**Question**: Which event ID format should be used?
**Options**:
- A) Timestamp-sequence (`{timestamp}-{seq}`): Naturally sortable, compact, enables O(log n) binary search for replay. Example: `1708012800000-42`
- B) UUID-based (`evt-{uuid}`): Globally unique, no coordination needed, but requires linear scan for replay and larger on the wire
- C) Monotonic counter (`{jobId}-{counter}`): Per-job incrementing counter. Simplest, most compact, O(1) lookup by offset. Not globally unique but unique per job
**Answer**:

---

### Q2: Auto-Publish on Status Update
**Context**: The spec defines `POST /api/jobs/:jobId/events` for workers to explicitly post events, but the existing `PUT /api/jobs/:jobId/status` endpoint already handles status transitions. It's unclear whether status changes via the existing endpoint should automatically emit `job:status` events on the EventBus, or whether workers must explicitly POST both a status update and a separate event.
**Question**: Should the existing `PUT /api/jobs/:jobId/status` endpoint automatically publish `job:status` events to the EventBus?
**Options**:
- A) Auto-publish: Status updates via `PUT /api/jobs/:jobId/status` automatically emit `job:status` events. Workers don't need to double-post. Keeps events in sync with actual state.
- B) Explicit only: Workers must POST events separately. Decouples event publishing from status updates. More control but risks state/event drift.
- C) Auto-publish + allow explicit: Auto-publish on status change, but workers can also POST `job:status` events explicitly for richer payloads (e.g., with previousStatus). Deduplicate or accept both.
**Answer**:

---

### Q3: EventBus Buffer Configuration
**Context**: The spec says the ring buffer capacity is ~1000 events per job and is "configurable via `OrchestratorServerOptions`", but doesn't specify whether the grace period (5 minutes) or other EventBus settings should also be configurable options. Adding too many options increases API surface; too few limits operational flexibility.
**Question**: Which EventBus parameters should be exposed in `OrchestratorServerOptions`?
**Options**:
- A) Minimal: Only `eventBufferSize` (default 1000). Grace period and heartbeat interval are hardcoded constants.
- B) Moderate: `eventBufferSize`, `eventGracePeriod` (default 5 min), `sseHeartbeatInterval` (default 30s). Covers the three main tuning knobs.
- C) Full: All of the above plus `maxSubscribersPerJob`, `maxGlobalSubscribers`. Enables capacity planning for production deployments.
**Answer**:

---

### Q4: Global Stream Filter Matching
**Context**: The spec says `GET /api/events` supports filters for `tags`, `workflow`, and `status`, combined with AND logic. But the event payload (e.g., `step:complete`) doesn't inherently carry `tags` or `workflow` — those are properties of the Job, not the event. This means the EventBus needs access to job metadata to evaluate filters, which affects the architecture.
**Question**: How should the global stream filter against job-level properties like `tags` and `workflow`?
**Options**:
- A) Lookup on subscribe: When a client subscribes with filters, resolve matching job IDs from the job queue and subscribe to those. New jobs are checked against filters as they're created. Simple but requires job queue access in EventBus.
- B) Enrich events: Each event carries denormalized job metadata (`tags`, `workflow`, `status`) so filters can be evaluated against the event itself. Increases event payload size but keeps EventBus self-contained.
- C) Filter at broadcast: EventBus receives the jobId with each event, looks up the job from the queue at broadcast time to check filters. Slightly slower per-event but always uses current job state.
**Answer**:

---

### Q5: Stream Behavior for Already-Terminal Jobs
**Context**: The spec says subscribing to a non-existent job returns 404, and that streams auto-close on terminal state. But it doesn't specify what happens when a client subscribes to a job that is *already* in a terminal state (completed/failed/cancelled). The buffer may still contain events within the grace period.
**Question**: What should happen when a client subscribes to a job that has already reached a terminal state?
**Options**:
- A) Replay and close: Send all buffered events (including the terminal event), then immediately close the stream. Client gets the full history within the buffer.
- B) Return 410 Gone: Since the job is terminal, return an HTTP error indicating the stream is no longer available. Client should use `GET /api/jobs/:jobId` for final state.
- C) Replay only: Send buffered events but keep the connection open until the grace period cleanup. Allows late subscribers to catch up but wastes a connection.
**Answer**:

---

### Q6: step:output Event Volume Control
**Context**: The risks section mentions that `step:output` events could fill the buffer quickly for verbose jobs. A single workflow step might produce hundreds of log lines. The spec doesn't define whether output events should be treated differently (e.g., separate buffer, throttling, or batching).
**Question**: How should high-volume `step:output` events be handled to prevent buffer saturation?
**Options**:
- A) No special handling: All events share the same ring buffer. Verbose output will push out older events. Simple, and `Last-Event-ID` reconnection mitigates gaps.
- B) Batch output events: Aggregate multiple `step:output` lines into a single event with a line array (e.g., batch every 500ms or every 10 lines). Reduces event count significantly.
- C) Separate buffer: Use a secondary output-only buffer with its own size limit. Core events (status, phase, step) are never evicted by output noise.
- D) Output events bypass buffer: Stream `step:output` events to subscribers in real-time but don't store them in the ring buffer. Only structural events are replayable on reconnect.
**Answer**:

---

### Q7: Max Concurrent SSE Connections
**Context**: The success criteria mention supporting 50+ concurrent SSE connections per job, but there's no specified limit. Each SSE connection holds an open HTTP response, consuming a file descriptor and memory. Without a cap, a misbehaving or misconfigured client could exhaust server resources.
**Question**: Should there be a maximum number of concurrent SSE connections, and if so, what should the limits be?
**Options**:
- A) No enforced limit: Rely on OS-level file descriptor limits. Log warnings above a threshold. Keep it simple for a single-process server.
- B) Per-job limit: Cap at e.g. 100 connections per job stream. Return 503 when exceeded. Global stream has a separate limit.
- C) Global limit only: Cap total SSE connections across all streams at e.g. 500. Per-job distribution is first-come-first-served.
**Answer**:

---

### Q8: Client.subscribeEvents() Return Type
**Context**: The spec says `client.ts` should add `subscribeEvents()` and `publishEvent()` methods. The `publishEvent()` method is straightforward REST, but `subscribeEvents()` needs to return a streaming SSE connection. The existing client uses `fetch()` with timeout-based `AbortController`. SSE clients typically use `EventSource` (browser) or a streaming fetch reader (Node.js).
**Question**: What API shape should `OrchestratorClient.subscribeEvents()` expose for Node.js consumers?
**Options**:
- A) AsyncIterator: Return `AsyncIterable<JobEvent>` that yields events. Clean for `for await` loops. Handles cleanup on break/return. Most idiomatic for Node.js streams.
- B) Callback-based: Accept `onEvent(event: JobEvent)` and `onError(err: Error)` callbacks. Return a `{ close(): void }` handle. Simple, familiar pattern.
- C) EventEmitter: Return an EventEmitter subclass with typed events. Matches the `EventSource` browser API pattern. Allows `.on('step:complete', ...)` per-type listeners.
**Answer**:

---

### Q9: POST /api/jobs/:jobId/events Authorization Scope
**Context**: The spec says workers are "trusted" and authenticated via the same Bearer token. However, any authenticated client (extension, dashboard) could also POST events to any job, potentially injecting fake progress events. The spec's "Out of Scope" mentions per-job authorization may come later, but it's worth confirming whether POST should be restricted now.
**Question**: Should `POST /api/jobs/:jobId/events` be restricted to the worker assigned to that job?
**Options**:
- A) No restriction: Any authenticated client can POST events to any job. Matches current trust model. Simplest implementation.
- B) Worker-only check: Verify that the request comes from the worker currently assigned to the job (via worker ID in the auth token or a header). Prevents event injection from other clients.
- C) Separate token scope: Introduce a `role` claim (worker vs. client) in the auth token. Only worker-role tokens can POST events. Adds auth complexity but clear separation.
**Answer**:

---

### Q10: Job Status Sync on Terminal Events
**Context**: When a worker posts a `job:status` event with a terminal status (completed/failed/cancelled), should this also update the job's actual status in the job queue? Currently, job status is updated via `PUT /api/jobs/:jobId/status` or `POST /api/jobs/:jobId/result`. If events and status are separate channels, they could get out of sync — e.g., a terminal event is broadcast but the job queue still shows "running".
**Question**: Should posting a terminal `job:status` event via `POST /api/jobs/:jobId/events` also update the job's status in the queue?
**Options**:
- A) Events are passive: Events are informational only. Job state is managed exclusively through existing status/result endpoints. Workers must update both channels.
- B) Auto-sync terminal states: If a `job:status` event with a terminal status is posted, automatically update the job queue status and trigger cleanup. Reduces risk of state drift.
- C) Validate consistency: When a terminal event is posted, check that the job queue already shows that terminal status. Reject the event if states don't match (return 409 Conflict).
**Answer**:

