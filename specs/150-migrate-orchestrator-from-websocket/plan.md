# Implementation Plan: Migrate Orchestrator from WebSocket to SSE

**Feature**: Replace WebSocket with Server-Sent Events for real-time updates
**Branch**: `150-migrate-orchestrator-from-websocket`
**Status**: Complete

## Summary

This feature migrates the orchestrator's real-time communication from WebSocket to Server-Sent Events (SSE). SSE provides a simpler, more scalable solution for our unidirectional (server → client) update pattern. The migration includes creating a new SSE module, adding SSE endpoints, and removing the existing WebSocket implementation.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript |
| Runtime | Node.js 20+ |
| Framework | Fastify 5.x |
| Package | `@generacy-ai/orchestrator` |
| Testing | Vitest |

### Dependencies to Add
- None (SSE is native HTTP, Fastify handles it natively)

### Dependencies to Remove
- `@fastify/websocket` (^11.0.0)
- `@types/ws` (devDependency)

## Project Structure

```
packages/orchestrator/src/
├── sse/                          # NEW: SSE module
│   ├── index.ts                  # Module exports
│   ├── stream.ts                 # SSE stream creation and management
│   ├── events.ts                 # Event type definitions
│   └── subscriptions.ts          # Subscription management (adapted from WS)
├── routes/
│   └── events.ts                 # NEW: SSE endpoint routes
├── types/
│   ├── sse.ts                    # NEW: SSE type definitions
│   └── websocket.ts              # DELETE after migration
├── websocket/                    # DELETE entire directory
│   ├── handler.ts
│   ├── messages.ts
│   ├── subscriptions.ts
│   └── index.ts
└── server.ts                     # Modify: remove WS, add SSE
```

## Implementation Phases

### Phase 1: Create SSE Infrastructure

Create the SSE module with stream management and event serialization:

1. **Create SSE type definitions** (`types/sse.ts`)
   - Define SSE event types mapping from existing WebSocket events
   - Create SSE-specific interfaces for event formatting
   - Reuse existing channel and filter types

2. **Create SSE stream manager** (`sse/stream.ts`)
   - `SSEStream` class for managing individual connections
   - `createSSEResponse()` helper to set up SSE headers
   - Heartbeat/keep-alive mechanism (configurable interval)
   - `Last-Event-ID` support for reconnection

3. **Adapt subscription logic** (`sse/subscriptions.ts`)
   - Migrate `SubscriptionManager` from WebSocket to SSE
   - Use `ServerResponse` instead of `WebSocket` objects
   - Maintain channel-based subscription model
   - Preserve filter matching logic

4. **Create event serialization** (`sse/events.ts`)
   - `formatSSEEvent()` function for proper SSE formatting
   - Event ID generation (unique, monotonic)
   - Handle multi-line data serialization

### Phase 2: Create SSE Endpoints

Add HTTP endpoints that return SSE streams:

1. **Create events route file** (`routes/events.ts`)
   - `GET /events` - Global event stream (all channels)
   - `GET /workflows/:id/events` - Workflow-specific events
   - `GET /queue/events` - Queue events

2. **Implement authentication**
   - Bearer token in Authorization header (reuse existing JWT auth)
   - Validate before establishing stream
   - Handle auth errors with proper HTTP status codes

3. **Implement connection handling**
   - Track active connections for cleanup
   - Handle client disconnect detection
   - Implement graceful shutdown

### Phase 3: Update Server Configuration

Modify server.ts to use SSE instead of WebSocket:

1. **Remove WebSocket registration**
   - Remove `@fastify/websocket` plugin registration
   - Remove `setupWebSocketHandler()` call

2. **Add SSE routes**
   - Import and register events routes
   - Pass services to SSE handlers

3. **Update graceful shutdown**
   - Close active SSE connections on shutdown
   - Drain connections before exit

### Phase 4: Remove WebSocket Code

Clean removal of WebSocket implementation:

1. **Delete WebSocket module**
   - Remove `src/websocket/` directory entirely
   - Remove `types/websocket.ts` file
   - Update `types/index.ts` exports

2. **Update package.json**
   - Remove `@fastify/websocket` dependency
   - Remove `@types/ws` devDependency

3. **Update imports**
   - Remove any lingering WebSocket imports
   - Update any tests that reference WebSocket

### Phase 5: Testing & Documentation

1. **Create SSE tests**
   - Unit tests for stream management
   - Integration tests for endpoints
   - Reconnection behavior tests

2. **Update existing tests**
   - Remove WebSocket-specific tests
   - Add SSE equivalents

## API Endpoints

### GET /events

Global event stream for all channels.

**Headers**:
- `Authorization: Bearer <token>` (required)
- `Accept: text/event-stream`
- `Last-Event-ID: <event-id>` (optional, for reconnection)

**Query Parameters**:
- `channels`: Comma-separated list (default: all)
- `workflowId`: Filter to specific workflow

**Response**: `text/event-stream`

### GET /workflows/:id/events

Workflow-specific event stream.

**Headers**: Same as above

**Response**: `text/event-stream` with workflow events only

### GET /queue/events

Queue update event stream.

**Headers**: Same as above

**Response**: `text/event-stream` with queue events only

## Event Format

```
event: workflow:progress
id: evt_abc123_001
data: {"workflowId":"wf_abc","step":"verify","progress":75}

event: queue:updated
id: evt_abc123_002
data: {"action":"added","item":{"id":"qi_xyz"}}

: heartbeat

event: error
id: evt_abc123_003
data: {"type":"error","title":"Connection Error","status":500}
```

## Key Technical Decisions

### Decision 1: Use Native Fastify SSE (No Plugin)
SSE is simple HTTP - we don't need a plugin. Fastify's reply.raw provides direct access to the Node.js response stream.

### Decision 2: Reuse Subscription Logic
The existing `SubscriptionManager` pattern works well. We'll adapt it for SSE's `ServerResponse` instead of WebSocket objects.

### Decision 3: Bearer Token Auth (Default)
Using standard HTTP Authorization header aligns with existing auth patterns. Query parameter fallback can be added later for browser EventSource if needed.

### Decision 4: Breaking Change (Clean Migration)
Given the clarification questions are pending, this plan assumes breaking change approach (remove WebSocket entirely). This simplifies implementation and reduces code complexity.

## Files to Create

| File | Purpose |
|------|---------|
| `src/sse/index.ts` | Module exports |
| `src/sse/stream.ts` | SSE stream management |
| `src/sse/events.ts` | Event serialization |
| `src/sse/subscriptions.ts` | Subscription manager |
| `src/routes/events.ts` | SSE endpoint routes |
| `src/types/sse.ts` | SSE type definitions |
| `tests/sse/stream.test.ts` | Stream unit tests |
| `tests/routes/events.test.ts` | Endpoint integration tests |

## Files to Modify

| File | Changes |
|------|---------|
| `src/server.ts` | Remove WS plugin, add SSE routes |
| `src/routes/index.ts` | Export events routes |
| `src/types/index.ts` | Export SSE types, remove WS types |
| `package.json` | Remove ws dependencies |

## Files to Delete

| File | Reason |
|------|--------|
| `src/websocket/handler.ts` | Replaced by SSE |
| `src/websocket/messages.ts` | Replaced by SSE events |
| `src/websocket/subscriptions.ts` | Adapted for SSE |
| `src/websocket/index.ts` | Replaced by SSE |
| `src/types/websocket.ts` | Replaced by SSE types |

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Client compatibility | Breaking change for WS clients | Clear documentation, version bump |
| Connection limits | SSE connections consume resources | Implement per-client limits (3-5 max) |
| Proxy timeouts | Some proxies may close idle connections | Heartbeat at 15-30s interval |
| Authentication | Query param tokens may leak in logs | Prefer Authorization header |

## Open Questions (from Clarifications)

The following questions are pending answers and may affect implementation:

1. **SSE Authentication method** - Plan assumes Bearer token
2. **Heartbeat interval** - Plan uses 30s as default
3. **Connection limits** - Plan includes 3 per client
4. **Error event format** - Plan uses dedicated error event type
5. **Breaking change strategy** - Plan assumes clean break

These can be adjusted during implementation if answers come in.

---

*Generated by speckit*
