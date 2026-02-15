# Feature Specification: Orchestrator SSE Endpoint for Real-Time Job Event Streaming

**Branch**: `176-orchestrator-add-sse-endpoint` | **Issue**: #176 | **Epic**: #175 (Real-time workflow monitoring) | **Date**: 2026-02-15 | **Status**: Draft

## Summary

Add Server-Sent Events (SSE) endpoints to the orchestrator so that clients (VS Code extension, dashboards) can subscribe to real-time job events instead of polling `GET /api/jobs/:id`. Workers post events as jobs execute; the orchestrator buffers them in memory and broadcasts to all SSE subscribers. Reconnecting clients replay missed events via `Last-Event-ID`.

## Current State

The orchestrator (`packages/generacy/src/orchestrator/server.ts`) is a plain Node.js HTTP server using `node:http` with a custom router. It exposes REST endpoints for job submission, polling, status updates, and result reporting. The extension currently polls `GET /api/jobs/:id` on an interval to check status — there is no mechanism for push-based event delivery.

Key existing infrastructure:
- **Router**: `createRouter()` + `pathToRegex()` in `router.ts` — regex-based route matching with path params
- **Job model**: `Job` type in `types.ts` with statuses `pending | assigned | running | completed | failed | cancelled`
- **Job result model**: `JobResult` with `phases[]` and `steps[]` arrays
- **Auth**: Bearer token via `ORCHESTRATOR_TOKEN` env var, skipped for `/api/health`
- **No external dependencies** — server uses only `node:http` and `node:crypto`

## User Stories

### US1: Extension Developer Subscribes to Job Events

**As a** VS Code extension developer,
**I want** to open an SSE stream for a specific job,
**So that** I can show real-time phase/step progress in the UI instead of polling every 30 seconds.

**Acceptance Criteria**:
- [ ] `GET /api/jobs/:jobId/events` returns `Content-Type: text/event-stream`
- [ ] Events arrive within 100ms of being posted by the worker
- [ ] Stream includes `job:status`, `phase:start`, `phase:complete`, `step:start`, `step:complete`, and `step:output` events
- [ ] Stream auto-closes when the job reaches a terminal state (`completed`, `failed`, `cancelled`)
- [ ] Connection drop and reconnect with `Last-Event-ID` replays all missed events from the buffer

### US2: Worker Reports Granular Progress Events

**As a** worker process executing a job,
**I want** to post events to the orchestrator as phases and steps execute,
**So that** subscribers are notified in real time of job progress.

**Acceptance Criteria**:
- [ ] `POST /api/jobs/:jobId/events` accepts a JSON event payload
- [ ] Posted events are buffered in the per-job ring buffer
- [ ] Posted events are broadcast to all active SSE subscribers for that job
- [ ] Events are validated: must include `type`, `data`; `id` and `timestamp` are server-assigned if omitted
- [ ] Returns `404` if the job does not exist

### US3: Dashboard Monitors All Active Jobs

**As a** dashboard user,
**I want** to subscribe to events across all jobs (optionally filtered),
**So that** I can see a live feed of all active workflow executions.

**Acceptance Criteria**:
- [ ] `GET /api/events` returns an SSE stream of events across all jobs
- [ ] Optional query params: `tags`, `workflow`, `status` filter the events
- [ ] Reconnection with `Last-Event-ID` replays missed events from the global buffer
- [ ] Heartbeat comments (`: heartbeat`) keep the connection alive through proxies

### US4: Reliable Reconnection

**As a** client with an intermittent connection,
**I want** to resume an SSE stream from where I left off,
**So that** I don't miss any events during brief disconnections.

**Acceptance Criteria**:
- [ ] `Last-Event-ID` header is respected on reconnection
- [ ] Events are replayed in order from the buffer starting after the given event ID
- [ ] If the event ID is no longer in the buffer (too old), the stream starts with the oldest available event and a `warning` event indicating gap

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GET /api/jobs/:jobId/events` — SSE stream for a specific job | P1 | Returns `text/event-stream`. Requires auth. Returns 404 if job not found. |
| FR-002 | `POST /api/jobs/:jobId/events` — Workers post events for a job | P1 | Accepts JSON body. Server assigns `id` (UUID) and `timestamp` if absent. |
| FR-003 | `GET /api/events?tags=...&workflow=...&status=...` — Global SSE stream | P2 | Streams events for all jobs, filtered by optional query params. |
| FR-004 | In-memory event buffer per job (ring buffer, ~1000 events) | P1 | `Map<jobId, RingBuffer>`. Oldest events evicted when buffer is full. |
| FR-005 | SSE connection registry per job | P1 | `Map<jobId, Set<ServerResponse>>` for targeted broadcast. |
| FR-006 | Global subscriber set for `GET /api/events` | P2 | Separate set with per-connection filter predicates. |
| FR-007 | `Last-Event-ID` reconnection support | P1 | Replay missed events from buffer. Send `warning` event if ID not found. |
| FR-008 | Heartbeat comments every 30s | P1 | `: heartbeat\n\n` to prevent proxy/LB timeouts. |
| FR-009 | Auto-close stream on job terminal state | P1 | Send final `job:status` event with terminal status, then close response. Grace period of 5s for late events before closing. |
| FR-010 | Buffer cleanup after job terminal state | P2 | Retain buffer for 5 minutes after terminal state for late reconnections, then evict. |
| FR-011 | SSE response headers | P1 | `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`. |
| FR-012 | Event validation on POST | P1 | Require `type` field. Validate `type` against allowed event types. Reject with 400 on invalid payload. |
| FR-013 | Graceful shutdown drains SSE connections | P2 | On server close, end all SSE responses cleanly. |
| FR-014 | Connection limit per job | P3 | Max 10 concurrent SSE connections per job to prevent resource exhaustion. |

## Event Types

| Event Type | Emitted By | Description |
|------------|-----------|-------------|
| `job:status` | Orchestrator / Worker | Job status changed (pending→running, running→completed, etc.) |
| `phase:start` | Worker | A workflow phase has started executing |
| `phase:complete` | Worker | A workflow phase has finished (success or failure) |
| `step:start` | Worker | A workflow step has started executing |
| `step:complete` | Worker | A workflow step has finished (success or failure) |
| `step:output` | Worker | Incremental output from a running step (e.g., log lines) |
| `action:error` | Worker | A non-fatal error during step execution |
| `log:append` | Worker | General log message appended to job log |

## Event Format (SSE Wire Format)

```
id: evt-550e8400-e29b-41d4-a716-446655440000
event: step:complete
data: {"jobId":"job-uuid","phaseName":"specification","stepName":"specify","duration":199317,"status":"completed"}

```

Each event posted via `POST /api/jobs/:jobId/events`:

```json
{
  "type": "step:complete",
  "data": {
    "phaseName": "specification",
    "stepName": "specify",
    "duration": 199317,
    "status": "completed"
  }
}
```

Server enriches with:
- `id`: `evt-{uuid}` (unique, monotonically ordered per job)
- `timestamp`: Unix epoch milliseconds
- `jobId`: From the URL path parameter

## API Details

### `GET /api/jobs/:jobId/events`

**Auth**: Required (Bearer token)

**Response**: `200 OK` with `Content-Type: text/event-stream`

**Headers sent**:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Reconnection**: If `Last-Event-ID` header is present, replay all buffered events after that ID before streaming live events.

**Error responses**:
- `404` — Job not found
- `401` — Authentication required
- `429` — Too many connections for this job (if FR-014 enforced)

### `POST /api/jobs/:jobId/events`

**Auth**: Required (Bearer token)

**Request body**:
```json
{
  "type": "step:complete",
  "data": { ... }
}
```

**Response**: `201 Created`
```json
{
  "id": "evt-550e8400-e29b-41d4-a716-446655440000",
  "timestamp": 1234567890123
}
```

**Error responses**:
- `400` — Invalid event type or missing required fields
- `404` — Job not found
- `401` — Authentication required

### `GET /api/events`

**Auth**: Required (Bearer token)

**Query parameters**:
| Param | Type | Description |
|-------|------|-------------|
| `tags` | `string` | Comma-separated tag filter (matches any) |
| `workflow` | `string` | Workflow name filter |
| `status` | `string` | Comma-separated job status filter |

**Response**: Same SSE format as job-specific endpoint, but events from all matching jobs.

## Architecture

### New File: `packages/generacy/src/orchestrator/event-bus.ts`

Core module containing:

1. **`RingBuffer<T>`** — Fixed-size circular buffer for event storage. Supports iteration, lookup by ID, and slice-from-ID.

2. **`EventBus`** — Manages event buffering and subscriber broadcasting:
   - `buffers: Map<string, RingBuffer<JobEvent>>` — Per-job event buffers
   - `subscribers: Map<string, Set<ServerResponse>>` — Per-job SSE connections
   - `globalSubscribers: Set<{ res: ServerResponse, filter: EventFilter }>` — Global stream connections
   - `emit(jobId, event)` — Buffer + broadcast to job + global subscribers
   - `subscribe(jobId, res, lastEventId?)` — Register SSE connection, replay if needed
   - `subscribeGlobal(res, filter, lastEventId?)` — Register global SSE connection
   - `unsubscribe(jobId, res)` — Remove SSE connection
   - `cleanup(jobId)` — Schedule buffer removal after grace period

### Modified File: `packages/generacy/src/orchestrator/server.ts`

- Import `EventBus` and instantiate alongside `WorkerRegistry` and `JobQueue`
- Register three new routes via `pathToRegex()` + `createRouter()`
- Add handlers: `streamJobEvents`, `postJobEvent`, `streamAllEvents`
- Hook into server close to drain SSE connections
- When job status changes to terminal via `updateJobStatus` or `reportResult`, emit `job:status` event and schedule stream closure

### Modified File: `packages/generacy/src/orchestrator/types.ts`

Add:
- `JobEventType` — Union of event type strings
- `JobEvent` — Event structure with `id`, `type`, `timestamp`, `jobId`, `data`
- `EventFilter` — Filter criteria for global stream

### Modified File: `packages/generacy/src/orchestrator/index.ts`

Export new types and `EventBus` class.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `packages/generacy/src/orchestrator/event-bus.ts` | **Create** | RingBuffer, EventBus, SSE helpers |
| `packages/generacy/src/orchestrator/server.ts` | **Modify** | Add 3 routes, instantiate EventBus, hook shutdown |
| `packages/generacy/src/orchestrator/types.ts` | **Modify** | Add event types and filter interface |
| `packages/generacy/src/orchestrator/index.ts` | **Modify** | Export new types and EventBus |
| `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts` | **Create** | Unit tests for RingBuffer and EventBus |
| `packages/generacy/src/orchestrator/__tests__/server.test.ts` | **Modify** | Add integration tests for SSE endpoints |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event delivery latency (POST → SSE) | < 100ms p99 | Timestamp delta in integration test |
| SC-002 | Reconnection replay completeness | 100% of buffered events replayed | Integration test: disconnect, post events, reconnect, verify count |
| SC-003 | Memory per job buffer | < 500 KB for 1000 events | Unit test: measure buffer size with realistic payloads |
| SC-004 | Concurrent connections per job | Supports 10 simultaneous subscribers | Integration test: open 10 streams, verify all receive events |
| SC-005 | Auto-close on terminal state | Stream ends within 10s of job completion | Integration test: complete job, verify stream closure |
| SC-006 | Buffer cleanup | Buffer freed within 6 minutes of terminal state | Unit test: verify buffer eviction after grace period |
| SC-007 | All existing tests pass | 0 regressions | `pnpm test` passes |

## Assumptions

- The orchestrator runs as a single process (no horizontal scaling needed for SSE state). If scaling is needed later, Redis Pub/Sub can replace the in-memory EventBus.
- Workers have reliable connectivity to the orchestrator and will POST events synchronously during execution.
- The ring buffer size of 1000 events per job is sufficient for typical workflow executions (most workflows have <100 phases/steps).
- The 5-minute grace period for buffer cleanup after terminal state is sufficient for late-reconnecting clients.
- The existing bearer token auth model is sufficient for SSE connections (no need for per-stream tokens).
- `node:http` `ServerResponse` supports long-lived SSE connections without additional dependencies (no need for Fastify or Express).
- Proxy/load balancer compatibility is handled by `X-Accel-Buffering: no` and `Cache-Control: no-cache` headers.

## Out of Scope

- **WebSocket support** — SSE is simpler, unidirectional, and sufficient for this use case. WebSocket can be considered later if bidirectional communication is needed.
- **Persistent event storage** — Events are in-memory only. Persistent storage (database/Redis) for event replay across restarts is a future enhancement.
- **Horizontal scaling / cross-instance broadcast** — SSE state is per-process. Multi-instance support (e.g., Redis Pub/Sub) is deferred to a future issue.
- **Client-side SSE implementation** — The `OrchestratorClient` class and VS Code extension updates to consume SSE are tracked in separate issues.
- **Rate limiting on POST /api/jobs/:jobId/events** — Workers are trusted internal services; rate limiting can be added if abuse is observed.
- **Event persistence for audit/history** — Historical event queries are not part of this feature.
- **Binary/file event payloads** — Events carry JSON data only; file attachments or binary streams are not supported.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Memory growth from unbounded jobs | High — OOM if many concurrent jobs | Ring buffer caps per-job. Cleanup on terminal state + grace period. Monitor total buffer count. |
| Stale SSE connections (client disappears without closing) | Medium — Leaked ServerResponse objects | Detect via `res.socket?.destroyed` check on heartbeat interval. Remove destroyed connections. |
| Proxy buffering breaks SSE | Medium — Events arrive in batches | `X-Accel-Buffering: no` header. Document proxy configuration requirements. |
| Race between POST and terminal state | Low — Events posted after stream closes | 5s grace period between terminal event and stream close. Buffer retains events for 5min. |

---

*Generated by speckit*
