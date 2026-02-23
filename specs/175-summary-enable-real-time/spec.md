# Feature Specification: Real-Time Workflow Monitoring & Conversation Viewing

Enable real-time monitoring of workflow execution and live viewing of Claude conversations from within the Generacy VS Code extension.

**Branch**: `175-summary-enable-real-time` | **Date**: 2026-02-23 | **Status**: Draft

## Summary

Remote/cloud job execution in Generacy is currently invisible to extension users. The extension only sees polling-based status updates every ~30 seconds with no step-level detail, logs, or conversation output. This feature bridges that gap by forwarding `WorkflowExecutor` events from workers through the orchestrator to the extension via SSE, enabling the same rich progress and log experience that local execution already provides.

## Background

The infrastructure is partially built across three packages:

**What exists today:**

- **WorkflowExecutor** (`packages/workflow-engine/src/executor/`) emits 14 event types via `ExecutionEventEmitter`: `execution:start`, `execution:complete`, `execution:error`, `execution:cancel`, `phase:start`, `phase:complete`, `phase:error`, `step:start`, `step:complete`, `step:error`, `step:output`, `action:start`, `action:complete`, `action:retry`
- **Extension** (`packages/generacy-extension/src/views/local/runner/`) has `WorkflowOutputChannel` and `ExecutionStatusBarProvider` that handle these events for local execution — structured logs, phase/step progress tracking, progress notifications with cancellation
- **Orchestrator** (`packages/orchestrator/src/`) has REST API for workflow CRUD, plus existing SSE infrastructure (`SSEStream`, `SSESubscriptionManager`) with channel-based subscriptions, event buffering (last 100 events, 60s retention), and reconnection support via `Last-Event-ID`
- **Workers** (`src/worker/health/heartbeat.ts`) publish heartbeats to Redis with `WorkerStatus` (`idle`/`busy`/`stopped`) and basic `WorkerMetrics`, but no granular step-level progress

**The gap:** Executor events stay local to the worker process and are never forwarded to the orchestrator. The existing SSE infrastructure broadcasts workflow-level state changes (`workflow:started`, `workflow:completed`) but not the fine-grained executor events (`step:start`, `step:output`, `action:retry`). For remote jobs, the extension is blind to what's happening inside the workflow.

## Architecture

```
┌─────────────────┐     events      ┌──────────────┐      SSE       ┌───────────────┐
│ WorkflowExecutor│───────────────→ │ Orchestrator │──────────────→ │ VS Code Ext   │
│ (in worker)     │  POST /events   │ (event bus)  │  GET /events   │ (webview)     │
│                 │                 │              │                │               │
│ • phase:start   │  claude stdout  │ • buffer     │  subscribe     │ • progress    │
│ • step:complete │───────────────→ │ • broadcast  │──────────────→ │ • logs        │
│ • step:output   │  POST /logs     │ • persist    │  GET /logs     │ • conversation│
│ • action:retry  │                 │              │                │ • notifications│
└─────────────────┘                 └──────────────┘                └───────────────┘
```

**Data flow:**
1. Worker's `WorkflowExecutor` emits events locally via `ExecutionEventEmitter`
2. A new `EventForwarder` in the worker captures these events and POSTs them to the orchestrator (`POST /workflows/:id/events`)
3. Worker captures Claude process stdout and POSTs conversation chunks to the orchestrator (`POST /workflows/:id/logs`)
4. Orchestrator receives events, buffers them in-memory, and broadcasts via existing `SSESubscriptionManager` on the `workflows` channel
5. Extension subscribes to `GET /workflows/:id/events` SSE stream and dispatches events to the existing `WorkflowOutputChannel` and `ExecutionStatusBarProvider`

## Child Issues

Implementation is broken into layers, each independently valuable:

### Layer 1: Event Pipeline (Orchestrator + Worker)
- [ ] #176 Orchestrator: Add SSE endpoint for real-time job event streaming
- [ ] #177 Worker: Forward executor events to orchestrator via REST
- [ ] #178 Worker: Capture and stream claude conversation output to orchestrator

### Layer 2: Extension UI
- [ ] #179 Extension: Real-time job progress view with phase/step detail
- [ ] #180 Extension: Live conversation/log viewer for remote jobs
- [ ] #181 Extension: Job completion notifications and error alerts

## User Stories

### US1: Real-Time Step Progress

**As a** developer monitoring a remote workflow,
**I want** to see which phase and step is currently executing, along with completion percentage and timing,
**So that** I can understand workflow progress without waiting for the final result or polling status.

**Acceptance Criteria:**
- [ ] Extension shows the current phase name and step name for a running remote workflow
- [ ] Progress percentage updates in real-time (sub-second latency from worker to extension)
- [ ] Elapsed time is displayed per-phase and per-step
- [ ] Step completion/failure events appear immediately — not on the next 30s poll
- [ ] Progress display matches the format already used for local execution (`ExecutionStatusBarProvider`)

### US2: Live Conversation Viewer

**As a** developer debugging a remote workflow,
**I want** to watch the Claude conversation output as it streams in real-time,
**So that** I can see tool calls, responses, and reasoning without waiting for job completion.

**Acceptance Criteria:**
- [ ] Extension displays streaming Claude stdout for a selected remote job
- [ ] Output appears within 2 seconds of being produced on the worker
- [ ] Tool calls and tool responses are visually distinguishable in the output
- [ ] Conversation viewer can be opened for any currently-running job
- [ ] Viewer continues to receive output if the connection is briefly interrupted (SSE reconnection)

### US3: Job Dashboard

**As a** developer managing multiple workflows,
**I want** a dashboard showing all jobs with their status, filterable by repository and status,
**So that** I can quickly find and drill into the job I care about.

**Acceptance Criteria:**
- [ ] Dashboard lists all jobs with: name, status, repository, start time, duration
- [ ] Jobs can be filtered by status (running, completed, failed, cancelled)
- [ ] Jobs can be filtered by repository
- [ ] Clicking a job opens its detail view with progress and conversation output
- [ ] Running jobs show live-updating progress indicators
- [ ] Dashboard updates in real-time as job statuses change (no manual refresh needed)

### US4: Job Notifications

**As a** developer who submitted a remote workflow,
**I want** to be notified when the job completes, fails, or encounters an error requiring attention,
**So that** I don't need to keep the dashboard open to know when action is needed.

**Acceptance Criteria:**
- [ ] VS Code notification appears when a monitored job completes successfully
- [ ] VS Code notification appears when a monitored job fails, including the error summary
- [ ] Notification includes an action button to open the job detail view
- [ ] Notifications for `action:retry` events indicate potential issues needing attention
- [ ] User can configure which notification types they receive (completion, failure, retries)

### US5: Resilient Connection

**As a** developer with an unstable network,
**I want** the real-time connection to automatically recover from interruptions,
**So that** I don't lose visibility into my running workflows.

**Acceptance Criteria:**
- [ ] SSE connection automatically reconnects after network interruption
- [ ] Missed events are replayed on reconnection using `Last-Event-ID` (leveraging existing buffer)
- [ ] Extension indicates connection status (connected/reconnecting/disconnected)
- [ ] No duplicate events are displayed after reconnection
- [ ] Graceful degradation: if SSE is unavailable, fall back to existing polling behavior

## Functional Requirements

### Layer 1: Event Pipeline

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Orchestrator exposes `GET /workflows/:id/events` SSE endpoint that streams executor-level events for a specific workflow | P1 | Extends existing SSE infrastructure (`SSESubscriptionManager`); filter by workflowId |
| FR-002 | Orchestrator exposes `POST /workflows/:id/events` REST endpoint for workers to submit executor events | P1 | Accepts `ExecutionEvent` payloads; validates event type against known 14 types |
| FR-003 | Orchestrator exposes `POST /workflows/:id/logs` REST endpoint for workers to submit conversation output chunks | P1 | Accepts text chunks with timestamps; buffers in-memory |
| FR-004 | Orchestrator exposes `GET /workflows/:id/logs` SSE endpoint that streams conversation output for a specific workflow | P1 | Separate from event stream to allow independent subscription |
| FR-005 | Orchestrator buffers events in-memory per workflow (last 200 events, 5-minute retention) | P1 | Extends existing SSESubscriptionManager buffering; enables reconnection replay |
| FR-006 | Orchestrator buffers conversation logs in-memory per workflow (last 500KB, 10-minute retention) | P2 | Ring buffer; older content evicted when limit exceeded |
| FR-007 | Worker registers an `EventForwarder` listener on `ExecutionEventEmitter` that POSTs events to orchestrator | P1 | Batches events if >5 per second to reduce HTTP overhead |
| FR-008 | Worker captures Claude process stdout/stderr and POSTs chunks to orchestrator log endpoint | P1 | Chunks at newline boundaries; max 4KB per POST |
| FR-009 | Worker event forwarding tolerates orchestrator unavailability without blocking execution | P1 | Fire-and-forget with retry queue (max 50 events); drop oldest on overflow |
| FR-010 | Event POST endpoints require worker authentication via existing auth mechanism | P1 | Reuse existing worker-to-orchestrator auth |

### Layer 2: Extension UI

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-011 | Extension subscribes to workflow event SSE stream for monitored remote jobs | P1 | Uses existing orchestrator API client |
| FR-012 | Extension dispatches received SSE events to existing `WorkflowOutputChannel.handleEvent()` | P1 | Reuse existing event → log formatting |
| FR-013 | Extension dispatches received SSE events to existing `ExecutionStatusBarProvider` | P1 | Reuse existing progress tracking |
| FR-014 | Extension provides a job dashboard webview listing all workflows with status | P2 | Extends existing orchestrator dashboard webview pattern |
| FR-015 | Job dashboard supports filtering by status and repository | P2 | Client-side filtering on cached workflow list |
| FR-016 | Extension provides a conversation viewer panel that displays streamed log output | P1 | New output channel or webview panel per job |
| FR-017 | Extension shows connection status indicator (connected/reconnecting/disconnected) in status bar | P2 | Visual indicator near existing execution status |
| FR-018 | Extension fires VS Code notifications on job completion, failure, and retry events | P2 | Configurable via extension settings |
| FR-019 | Extension falls back to existing polling behavior when SSE connection cannot be established | P1 | Graceful degradation; no loss of existing functionality |
| FR-020 | Extension manages SSE connection lifecycle (connect on job start, disconnect on job end/extension deactivate) | P1 | Prevent connection leaks; respect orchestrator's 3-connection-per-user limit |

## Technical Design Notes

### Event Forwarding Strategy

The worker `EventForwarder` should batch events to reduce HTTP overhead:
- Events are queued in-memory with a 200ms flush interval
- If the queue reaches 10 events, flush immediately
- Each batch is POSTed as an array to `POST /workflows/:id/events`
- On HTTP failure, events are re-queued with exponential backoff (max 3 retries)
- Queue overflow (>50 events) drops oldest events — execution must never block on event delivery

### Conversation Log Streaming

Claude process stdout is captured by the worker and forwarded differently from structured events:
- Raw text chunks (up to 4KB) are POSTed to `POST /workflows/:id/logs`
- Orchestrator appends to a per-workflow ring buffer (500KB max)
- SSE stream on `GET /workflows/:id/logs` sends chunks as they arrive
- On reconnection, client can request buffered content via query param `?since={timestamp}`

### SSE Connection Management in Extension

The extension must respect the orchestrator's 3-connection-per-user limit:
- One connection per actively-monitored workflow
- Connections are established lazily (when user opens job detail)
- Connections are closed when the job completes or user navigates away
- A connection pool manager tracks active connections and rejects new ones at limit

### Reuse of Existing Infrastructure

| Component | Exists | Reuse Strategy |
|-----------|--------|----------------|
| `ExecutionEventEmitter` | Yes | Add `EventForwarder` as a new listener alongside existing local listeners |
| `SSESubscriptionManager` | Yes | Add workflow-specific event channel; extend buffering config |
| `SSEStream` | Yes | Reuse for new per-workflow endpoints |
| `WorkflowOutputChannel` | Yes | Call `handleEvent()` with deserialized SSE events — same interface as local |
| `ExecutionStatusBarProvider` | Yes | Feed remote events through same progress tracking logic |
| Orchestrator auth | Yes | Reuse existing worker auth tokens for event POST endpoints |
| Webview infrastructure | Yes | Follow existing `orchestrator/webview.ts` pattern for job dashboard |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Event delivery latency (worker → extension) | < 2 seconds p95 | Timestamp comparison: event emission time vs. extension receipt time |
| SC-002 | Conversation output latency (Claude stdout → extension) | < 3 seconds p95 | Timestamp comparison: stdout capture vs. extension display |
| SC-003 | SSE reconnection recovery time | < 5 seconds | Time from connection drop detection to successful reconnection |
| SC-004 | Event delivery reliability | > 99% of events delivered during stable connection | Compare events emitted by worker vs. events received by extension in test harness |
| SC-005 | Zero impact on workflow execution performance | < 5% overhead on worker execution time | Benchmark with/without event forwarding enabled |
| SC-006 | Connection stability | SSE connections survive 8+ hours without manual intervention | Long-running test with periodic network disruptions |
| SC-007 | Memory usage (orchestrator event buffers) | < 50MB for 100 concurrent workflows | Monitor orchestrator heap during load test |

## Assumptions

- The orchestrator is reachable from both workers and the extension (same network or public endpoint)
- Workers and the orchestrator share an authentication mechanism that can be extended to event endpoints
- The existing `SSESubscriptionManager` can handle the increased event volume (estimated: 50-200 events/min per active workflow for structured events, higher for conversation chunks)
- Redis pub/sub (already used for worker heartbeats) can be used for internal orchestrator event distribution if the orchestrator scales to multiple instances
- Claude process stdout is available to the worker as a readable stream that can be tapped without interfering with normal execution
- VS Code's webview and output channel APIs support the update frequency needed (multiple updates per second)
- The 3-connection-per-user SSE limit in `SSESubscriptionManager` is sufficient for typical usage (monitoring 1-3 jobs simultaneously)

## Out of Scope

- **Persistent storage of events/logs** — In-memory buffers with time-based eviction are sufficient for v1; no database writes for event or conversation data
- **Multi-tenant authentication for event streams** — Event endpoints use existing worker/extension auth; no new auth system
- **Replaying historical conversation logs** — Once a job completes and buffers are evicted, conversation data is gone; no historical log retrieval
- **Modifying workflow execution from the extension** — This feature is read-only monitoring; pause/resume/cancel remain through existing REST endpoints
- **End-to-end encryption of event streams** — Transport-level TLS is sufficient; no application-level encryption of event payloads
- **Custom event filtering in the extension** — All events for a subscribed workflow are delivered; client-side filtering only
- **Mobile or web-based monitoring** — This feature targets the VS Code extension only
- **Rate limiting per event type** — Workers are trusted; no per-event-type throttling beyond the batch flush mechanism

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| High event volume overwhelms orchestrator | Event delivery delays, memory pressure | Batching on worker side (FR-007); buffer size limits (FR-005, FR-006); drop oldest on overflow |
| SSE connections exhaust orchestrator resources | Other API calls degraded | Connection limits already in place (max 3/user); lazy connection establishment; close on job completion |
| Network instability causes event loss | Missing progress updates in extension | SSE reconnection with event replay (FR-005); graceful fallback to polling (FR-019) |
| Claude stdout capture interferes with execution | Workflow failures | Capture via pipe tap, not interception; fire-and-forget forwarding (FR-009) |
| Orchestrator restart loses buffered events | Gap in event stream after restart | Acceptable for v1; extension shows "reconnected — some events may have been missed" |

---

*Generated by speckit*
