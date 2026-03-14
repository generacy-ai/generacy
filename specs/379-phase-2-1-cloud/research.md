# Research: @generacy-ai/cluster-relay

## Technology Decisions

### WebSocket Client Library

**Decision**: Use `ws` package

**Alternatives considered**:
- **Node.js built-in WebSocket** (Node 22+): Available via `globalThis.WebSocket`, but still considered experimental for client-side use. The monorepo targets Node >= 20, so this isn't guaranteed available. Additionally, the built-in WebSocket follows the browser API which lacks some server/client features (e.g., custom headers on handshake, ping/pong frame control).
- **Socket.IO client**: Overkill — adds protocol overhead (Engine.IO transport negotiation, namespaces, rooms) that isn't needed. The cloud relay service will be a raw WebSocket server, not Socket.IO.

**Rationale**: `ws` is the de facto Node.js WebSocket library. It provides low-level control over ping/pong frames, custom headers for authentication during handshake, and is thoroughly battle-tested. Minimal footprint (~50KB).

### Message Serialization

**Decision**: JSON over WebSocket text frames with Zod validation

**Alternatives considered**:
- **Protocol Buffers**: More efficient binary format, but adds build complexity (protoc codegen), a new dependency pattern, and makes debugging harder (can't read messages in logs).
- **MessagePack**: Binary JSON alternative, but the messages are small enough that JSON overhead is negligible and human readability during development is valuable.

**Rationale**: JSON is simple, debuggable, and consistent with the rest of the monorepo. Zod provides runtime type validation at the WebSocket message boundary, matching the config validation pattern used in `packages/orchestrator/src/config/`.

### Reconnection Strategy

**Decision**: Exponential backoff following `smee-receiver.ts` pattern

**Pattern**: `BASE_DELAY * 2^attempt`, capped at `MAX_BACKOFF_MS`
- Sequence: 5s → 10s → 20s → 40s → 80s → 160s → 300s
- Reset on successful connection
- AbortController for cancellation during graceful shutdown

**Key implementation details from smee-receiver.ts**:
- `while (this.running && !signal.aborted)` reconnection loop
- `private sleep(ms, signal)` helper for cancellable delays
- Backoff counter reset on successful connection establishment
- Separate `start()` / `stop()` lifecycle methods

### API Request Proxying

**Decision**: Native `fetch()` with `AbortSignal.timeout()`

**Rationale**: Node.js 20+ includes a stable `fetch()` implementation. Using native fetch avoids adding `axios` or `node-fetch` as dependencies. `AbortSignal.timeout()` provides clean timeout handling without manual timer management.

**Authentication**: Requests to the local orchestrator include `X-API-Key` header with the configured `ORCHESTRATOR_API_KEY`, matching the orchestrator's existing auth middleware pattern.

### Event Forwarding Architecture

**Decision**: Dual-mode — in-process EventEmitter interface (library) + SSE subscription (standalone)

**Library mode** (primary, used by issue 2.2):
- Orchestrator imports `ClusterRelay` and calls `relay.pushEvent(channel, event)` directly
- Avoids consuming one of the 3 SSE connection slots per user
- More efficient — no HTTP/SSE overhead for local event passing

**Standalone mode** (secondary, for CLI use):
- Interface defined but SSE subscription not implemented in this issue
- Will connect to orchestrator's `/events` SSE endpoint when implemented
- Requires `ORCHESTRATOR_API_KEY` with `workflows:read` and `queue:read` scopes

## Implementation Patterns

### Connection State Machine

```
disconnected ──connect()──→ connecting ──ws.open──→ authenticating ──handshake.ack──→ connected
     ↑                                                                                    │
     │                          ←── reconnect backoff ←── error/close ←────────────────────┘
     │
     └──────────────────────────── disconnect() ←──────────────────────────────────────────┘
```

### Message Flow

```
Cloud                    Relay                    Orchestrator
  │                        │                          │
  │──api_request──────────→│                          │
  │                        │──fetch(path, body)──────→│
  │                        │←─────────response────────│
  │←─api_response──────────│                          │
  │                        │                          │
  │←─event(channel, data)──│←─pushEvent() (lib mode)──│
  │                        │                          │
  │──heartbeat────────────→│                          │
  │←─heartbeat─────────────│                          │
```

### Error Handling Strategy

- **WebSocket errors**: Log and trigger reconnection
- **Proxy errors** (fetch failures): Return `api_response` with error status (502 for network, 504 for timeout)
- **Invalid messages**: Log warning, skip processing (don't crash the relay)
- **Auth failures**: Log error, attempt reconnection (API key may have been rotated)

## Key Sources/References

- `packages/orchestrator/src/services/smee-receiver.ts` — reconnection pattern
- `packages/orchestrator/src/sse/` — SSE event types and subscription model
- `packages/orchestrator/src/routes/health.ts` — health endpoint format (metadata source)
- `packages/orchestrator/src/routes/metrics.ts` — metrics endpoint format (metadata source)
- `packages/orchestrator/src/config/` — Zod config schema pattern
- `docs/cloud-platform-buildout-reference.md` (tetrad-development) — architecture overview

---

*Generated by speckit*
