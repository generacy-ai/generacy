# Research: #519 Cluster-Side IDE Tunnel Support

## Root Cause Analysis

### Problem 1: Schema Drops Tunnel Messages

`RelayMessageSchema` in `packages/cluster-relay/src/messages.ts:177-185` is a Zod `z.discriminatedUnion('type', [...])` with 7 variants: `api_request`, `api_response`, `event`, `conversation`, `heartbeat`, `handshake`, `error`. The cloud's `TunnelManager` sends messages with `type: 'tunnel_open'`, `'tunnel_data'`, `'tunnel_close'` — none of which match any discriminator. `parseRelayMessage()` returns `null` for these, and the relay silently drops them.

### Problem 2: No Cluster-Side Tunnel Handler

Even if the schema accepted tunnel messages, there's nothing in the cluster to act on them. The `relay.ts` dispatch handles `api_request` specially and forwards everything else to registered `messageHandlers`, but no handler is registered for tunnel lifecycle. The `control-plane` package manages code-server lifecycle (`CodeServerProcessManager`) but has no tunnel/socket proxying service.

### Problem 3: No Relay-to-Control-Plane Tunnel Bridge

The orchestrator's `RelayBridge.handleMessage()` dispatches `api_request`, `conversation`, lease protocol messages, but has no branch for tunnel types. Even with the schema fixed, tunnel messages would fall through the if/else-if chain silently.

## Technical Decisions

### Decision 1: Wire Format — Base64 Over JSON

**Choice**: `tunnel_data.data` is base64-encoded bytes transmitted as a JSON string field
**Rationale**: The relay WebSocket already uses JSON-framed messages for all types. Binary WebSocket frames would require protocol-level changes to the relay client/server. Base64 adds ~33% overhead but is acceptable for code-server traffic (primarily small JSON-RPC messages, UI events, and text diffs). A future optimization could add binary frame support.

### Decision 2: Handler Location — Control-Plane Package

**Choice**: `TunnelHandler` lives in `packages/control-plane/src/services/tunnel-handler.ts`
**Rationale**: Per clarification Q1 — the tunnel handler manages code-server lifecycle (auto-start, idle-touch), which is a control-plane responsibility. The orchestrator injects the relay send callback via constructor DI, keeping the control-plane decoupled from `cluster-relay`. This follows the same separation used for lifecycle actions (`code-server-start`/`code-server-stop` in `routes/lifecycle.ts`).

### Decision 3: Dependency Injection via Constructor

**Choice**: `TunnelHandler` accepts a `RelayMessageSender` interface in its constructor
**Rationale**: Per clarification Q1 — explicit injection is more testable than the module-level setter pattern (`setRelayPushEvent`). The interface is minimal: `{ send(message: unknown): void }`. The orchestrator provides `relay.send.bind(relay)` at boot. No temporal coupling ("must call setter before first message").

### Decision 4: Dispatch via RelayBridge (Not cluster-relay messageHandlers)

**Choice**: Add tunnel dispatch to `RelayBridge.handleMessage()` in the orchestrator
**Rationale**: The `RelayBridge` is the central message routing point — it already handles `api_request`, `conversation`, and lease protocol messages with direct if/else-if dispatch. Adding tunnel types here follows the established pattern and allows null-checking the handler (relay can operate without control-plane). Using the cluster-relay's generic `messageHandlers` array would require registering a closure and bypassing the type-safe dispatch pattern.

### Decision 5: Single Hardcoded Target Path

**Choice**: Restrict `tunnel_open.target` to `/run/code-server.sock` only
**Rationale**: Per clarification Q3 — accepting arbitrary paths would let a compromised cloud tunnel into any Unix socket in the container. Hardcoding the single allowed path is the right v1.5 security posture. Upgrade to a configurable allowlist when additional tunnel targets are needed.

### Decision 6: Auto-Start with Bounded Timeout

**Choice**: Call `CodeServerManager.start()` on `tunnel_open` with 10s timeout
**Rationale**: Per clarification Q2 — eliminates the race between cloud calling `code-server-start` and `tunnel_open`. The handler waits for the socket to appear (same poll-based approach as `CodeServerProcessManager.waitForSocket()`). On timeout, sends `tunnel_open_ack { status: 'error' }` so the cloud can surface an error to the user.

### Decision 7: Stateless Across Relay Reconnects

**Choice**: `cleanup()` destroys all sockets on relay disconnect; cloud re-sends `tunnel_open`
**Rationale**: Per clarification Q4 — the browser is the source of truth for active sessions. After a relay reconnect, the cloud's `TunnelManager` re-issues `tunnel_open` for active browser tabs. The cluster handler sees fresh opens and creates new socket connections. No cluster-side bookkeeping survives reconnect.

## Alternatives Considered

### A: Binary WebSocket Frames for Tunnel Data

Rejected — would require protocol-level changes to `cluster-relay`'s JSON-only message framing. Base64 overhead is acceptable for v1.5 code-server traffic.

### B: Separate WebSocket Connection for Tunnels

Rejected — adds infrastructure complexity (new port, new authentication). The existing relay WebSocket is already authenticated and encrypted (TLS). Multiplexing tunnel and API messages on the same connection is simpler.

### C: TunnelHandler in Orchestrator Package

Rejected per clarification Q1 — couples concerns. Code-server lifecycle is a control-plane responsibility. The orchestrator's role is wiring, not owning tunnel logic.

### D: Module-Level Setter for Relay Send

Rejected per clarification Q1 — `setRelayPushEvent` pattern works but has temporal coupling. Constructor injection is more testable and explicit.

### E: Generic Handler Registry in cluster-relay

Rejected — the cluster-relay package is a transport layer. Adding a handler registry would leak application concerns into it. The orchestrator's `RelayBridge` is the right dispatch point.

## Key Code Patterns

- **Zod discriminated union**: `RelayMessageSchema` uses `z.discriminatedUnion('type', [...])` — new message types must add both a Zod schema and a union member
- **RelayBridge if/else dispatch**: `handleMessage()` routes by `msg.type` with setter-injected optional services, each null-checked before calling
- **Module-level singleton**: `getCodeServerManager()` / `setCodeServerManager()` — TunnelHandler will consume this via constructor DI, not the global
- **`node:net` Unix socket client**: Standard `net.createConnection({ path })` for connecting to code-server socket; `socket.on('data')` for bidirectional proxying
- **Orchestrator wiring**: Services are created in `server.ts`, then injected into `RelayBridge` via setters (`setLeaseManager`, `setConversationManager`); `setTunnelHandler` follows this pattern
