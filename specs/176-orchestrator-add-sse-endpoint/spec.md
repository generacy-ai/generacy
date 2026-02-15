# Feature Specification: Orchestrator SSE Endpoint for Real-Time Job Event Streaming

**Branch**: `176-orchestrator-add-sse-endpoint` | **Date**: 2026-02-15 | **Status**: Draft
**Parent Epic**: #175 — Real-time workflow monitoring

## Summary

Add Server-Sent Events (SSE) endpoints to the orchestrator so clients (VS Code extension, dashboards) can subscribe to real-time job events without polling. Workers post events to the orchestrator, which buffers them in-memory and broadcasts to all connected SSE subscribers. Reconnection support via `Last-Event-ID` ensures no events are lost during transient disconnects.

### Problem

The orchestrator is REST-only. The VS Code extension currently polls `GET /api/jobs/:id` every 30 seconds to check job status. This introduces up to 30 seconds of latency for status changes, wastes resources when nothing has changed, and provides no visibility into phase/step-level progress.

### Solution

Three new endpoints:
1. **`GET /api/jobs/:jobId/events`** — SSE stream for a single job's events
2. **`GET /api/events`** — SSE stream for all jobs (with optional filters)
3. **`POST /api/jobs/:jobId/events`** — Workers post events that get buffered and broadcast

A new `EventBus` module (`event-bus.ts`) handles event buffering (ring buffer per job) and broadcasting to SSE subscribers.

## User Stories

### US1: Extension Developer Receives Real-Time Job Progress

**As a** VS Code extension developer,
**I want** to subscribe to an SSE stream for a specific job,
**So that** I can show real-time phase/step progress in the UI without polling.

**Acceptance Criteria**:
- [ ] Connecting to `GET /api/jobs/:jobId/events` returns an SSE stream with `Content-Type: text/event-stream`
- [ ] Events include `job:status`, `phase:start`, `phase:complete`, `step:start`, `step:complete`, `step:output`
- [ ] Each event has a unique `id` field for reconnection support
- [ ] The stream auto-closes with a terminal event when the job reaches `completed`, `failed`, or `cancelled`

### US2: Dashboard Developer Monitors All Active Jobs

**As a** dashboard developer,
**I want** to subscribe to a filtered SSE stream of events across all jobs,
**So that** I can build a live dashboard showing all active workflow executions.

**Acceptance Criteria**:
- [ ] Connecting to `GET /api/events` returns an SSE stream for all jobs
- [ ] Events can be filtered by query parameters: `tags`, `workflow`, `status`
- [ ] Multiple filters combine with AND logic
- [ ] New jobs automatically appear in the stream without reconnection

### US3: Worker Posts Job Events

**As a** worker process executing a job,
**I want** to post phase/step events to the orchestrator,
**So that** all subscribers receive real-time progress updates.

**Acceptance Criteria**:
- [ ] `POST /api/jobs/:jobId/events` accepts a JSON event payload
- [ ] Events are validated for required fields (`type`, `data`)
- [ ] Events are immediately broadcast to all SSE subscribers of that job
- [ ] Events are buffered in-memory for reconnecting clients
- [ ] Returns `404` if the job does not exist

### US4: Client Recovers After Disconnection

**As a** client that was temporarily disconnected,
**I want** to resume the SSE stream from where I left off,
**So that** I don't miss any events during network interruptions.

**Acceptance Criteria**:
- [ ] Sending `Last-Event-ID` header replays all buffered events after that ID
- [ ] Replayed events are sent in order before any new live events
- [ ] If the event ID is no longer in the buffer, the stream starts from the oldest buffered event
- [ ] Reconnection works for both per-job and global event streams

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `GET /api/jobs/:jobId/events` returns an SSE stream for job-specific events | P1 | Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive` |
| FR-002 | `GET /api/events` returns an SSE stream for all jobs with optional query filters | P1 | Filters: `tags` (comma-separated), `workflow` (name), `status` (comma-separated) |
| FR-003 | `POST /api/jobs/:jobId/events` accepts event payloads from workers | P1 | Validates `type` and `data` fields; returns `201` on success |
| FR-004 | Events are buffered in a per-job ring buffer (~1000 events per job) | P1 | Oldest events evicted when buffer is full |
| FR-005 | Events are broadcast to all active SSE connections subscribed to that job | P1 | Global stream receives all events; job stream receives only matching events |
| FR-006 | Each event has a unique, monotonically increasing `id` field | P1 | Format: `evt-{uuid}` or `{timestamp}-{sequence}` |
| FR-007 | `Last-Event-ID` header triggers replay of missed events from buffer | P1 | Events after the given ID are sent before switching to live mode |
| FR-008 | SSE stream auto-closes when job reaches terminal state | P1 | Terminal states: `completed`, `failed`, `cancelled`. Send final event then close |
| FR-009 | SSE heartbeat (`:ping`) sent every 30 seconds to keep connection alive | P2 | Prevents proxy/load balancer timeouts |
| FR-010 | Memory cleanup of event buffers after job terminal state + grace period | P2 | Grace period: 5 minutes (configurable). Allows late subscribers to catch up |
| FR-011 | Authentication required for all SSE endpoints (same Bearer token scheme) | P1 | Consistent with existing auth pattern in `server.ts` |
| FR-012 | Returns `404` if subscribing to events for a non-existent job | P1 | `GET /api/jobs/:jobId/events` with unknown jobId |
| FR-013 | Connection cleanup on client disconnect (detect `close` event on response) | P1 | Remove from subscriber set, prevent memory leaks |
| FR-014 | SSE `event:` field matches the event type (e.g., `event: step:complete`) | P2 | Allows `EventSource.addEventListener('step:complete', ...)` on client side |

## Technical Design

### Event Types

```typescript
type JobEventType =
  | 'job:status'        // Job status changed
  | 'phase:start'       // Workflow phase started
  | 'phase:complete'    // Workflow phase completed
  | 'step:start'        // Individual step started
  | 'step:complete'     // Individual step completed
  | 'step:output'       // Step produced output (logs, artifacts)
  | 'action:error'      // Non-fatal error during execution
  | 'log:append';       // Generic log line appended

interface JobEvent {
  id: string;           // Unique event ID for Last-Event-ID support
  type: JobEventType;   // SSE event type field
  timestamp: number;    // Unix epoch milliseconds
  jobId: string;        // Associated job ID
  data: Record<string, unknown>; // Type-specific payload
}
```

### Event Data Payloads (examples)

```typescript
// job:status
{ status: 'running', previousStatus: 'assigned' }

// phase:start / phase:complete
{ phaseName: 'specification', phaseIndex: 0, totalPhases: 3 }
{ phaseName: 'specification', duration: 45000, status: 'completed' }

// step:start / step:complete
{ phaseName: 'specification', stepName: 'specify', stepIndex: 0 }
{ phaseName: 'specification', stepName: 'specify', duration: 199317, status: 'completed' }

// step:output
{ phaseName: 'specification', stepName: 'specify', output: '...', stream: 'stdout' }

// action:error
{ message: 'Rate limit exceeded', code: 'RATE_LIMIT', retryable: true }

// log:append
{ line: 'Processing file 42/100...', level: 'info' }
```

### SSE Wire Format

```
event: step:complete
id: evt-abc123
data: {"id":"evt-abc123","type":"step:complete","timestamp":1234567890,"jobId":"job-uuid","data":{"phaseName":"specification","stepName":"specify","duration":199317,"status":"completed"}}

```

### New Module: `event-bus.ts`

**`EventBus` class** encapsulates all event state:

- `buffers: Map<string, RingBuffer<JobEvent>>` — per-job event ring buffer (capacity ~1000)
- `subscribers: Map<string, Set<SSEConnection>>` — per-job SSE connections
- `globalSubscribers: Set<SSEConnection>` — connections to the global event stream
- `cleanupTimers: Map<string, NodeJS.Timeout>` — grace period cleanup timers

**Key methods**:
- `publish(jobId: string, event: JobEvent): void` — buffer + broadcast
- `subscribe(jobId: string, res: ServerResponse, lastEventId?: string): void` — add subscriber, replay if needed
- `subscribeAll(res: ServerResponse, filters: EventFilters, lastEventId?: string): void` — global subscription
- `unsubscribe(jobId: string, res: ServerResponse): void` — remove subscriber on disconnect
- `scheduleCleanup(jobId: string, graceMs: number): void` — schedule buffer eviction
- `getBufferedEvents(jobId: string, afterId?: string): JobEvent[]` — replay from buffer

### Ring Buffer

Simple circular array implementation:
- Fixed capacity (default 1000, configurable via `OrchestratorServerOptions`)
- O(1) write, O(n) read for replay
- No external dependencies

### Integration with `server.ts`

Three new routes added to the existing router:
1. `GET /api/jobs/:jobId/events` → `subscribeJobEvents` handler
2. `GET /api/events` → `subscribeAllEvents` handler
3. `POST /api/jobs/:jobId/events` → `publishEvent` handler

The `EventBus` is instantiated alongside `WorkerRegistry` and `InMemoryJobQueue` in `createOrchestratorServer()`. It is exposed on the `OrchestratorServer` interface so tests and programmatic users can publish events directly.

### Files to Modify

| File | Change |
|------|--------|
| `packages/generacy/src/orchestrator/event-bus.ts` | **New file** — `EventBus` class, `RingBuffer`, SSE connection management |
| `packages/generacy/src/orchestrator/types.ts` | Add `JobEventType`, `JobEvent`, `EventFilters` types |
| `packages/generacy/src/orchestrator/server.ts` | Add 3 SSE route handlers, instantiate `EventBus`, expose on interface |
| `packages/generacy/src/orchestrator/client.ts` | Add `subscribeEvents()` and `publishEvent()` methods |
| `packages/generacy/src/orchestrator/index.ts` | Re-export new types and `EventBus` |
| `packages/generacy/src/orchestrator/__tests__/event-bus.test.ts` | **New file** — Unit tests for `EventBus` and `RingBuffer` |
| `packages/generacy/src/orchestrator/__tests__/server.test.ts` | Add integration tests for SSE endpoints |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event delivery latency | < 100ms from POST to SSE client | Timestamp comparison in integration test |
| SC-002 | Reconnection replay accuracy | 100% of buffered events replayed in order | Integration test with `Last-Event-ID` |
| SC-003 | Memory per job buffer | < 2MB for 1000 events (typical payload) | Measure buffer size in test |
| SC-004 | Connection cleanup | 0 leaked connections after client disconnect | Track subscriber count in tests |
| SC-005 | Stream auto-close | Stream closes within 1s of terminal state | Integration test timing |
| SC-006 | Concurrent subscribers | Supports 50+ concurrent SSE connections per job | Load test |

## Assumptions

- The orchestrator runs as a single process (no horizontal scaling). Event state is in-memory only — no need for Redis or shared state.
- Workers are trusted: event payloads from `POST /api/jobs/:jobId/events` are not deeply validated beyond required fields. Workers authenticated via same Bearer token.
- The existing Node.js HTTP server handles SSE natively without needing a library. `ServerResponse` supports streaming via `res.write()`.
- Event buffer size of ~1000 per job is sufficient for typical workflows (which have 5-20 phases with 1-5 steps each, plus log output).
- Clients use the native `EventSource` API or equivalent library that handles `Last-Event-ID` automatically on reconnection.
- The global events endpoint (`GET /api/events`) is intended for dashboards and admin tools, not high-throughput automation.

## Out of Scope

- **Persistent event storage**: Events are in-memory only. A future issue may add persistence to a database or log file for audit trails.
- **WebSocket support**: SSE is unidirectional (server→client) which is sufficient. Bidirectional communication (e.g., client sending commands mid-stream) is out of scope.
- **Horizontal scaling / distributed event bus**: No Redis pub/sub or shared event store. This is a single-process solution.
- **Event schema validation beyond required fields**: Workers are trusted; deep payload validation is deferred.
- **Rate limiting on POST endpoint**: Workers post events at the pace of execution; rate limiting is unnecessary for trusted workers.
- **Client-side SDK / EventSource wrapper**: This issue covers server-side only. Client integration is handled in downstream issues.
- **Compression**: SSE responses are not gzip-compressed. Can be added later if bandwidth is a concern.
- **Authentication scoping per job**: All authenticated clients can subscribe to any job's events. Per-job authorization may come later.

## Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Memory growth from event buffers | High memory if many concurrent jobs | Medium | Ring buffer caps at ~1000 events; cleanup timer evicts buffers after grace period |
| Stale SSE connections from crashed clients | Connection leak, growing subscriber sets | Medium | Detect `close` event on `ServerResponse`; periodic sweep of dead connections |
| Proxy/LB dropping idle SSE connections | Clients silently disconnected | Medium | 30-second heartbeat pings; `Last-Event-ID` reconnection |
| High event volume from `step:output` events | Buffer fills quickly for verbose jobs | Low | Consider separate buffer limits for output events, or log events bypass buffer |

---

*Generated by speckit*
