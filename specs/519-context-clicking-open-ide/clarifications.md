# Clarifications: 519-context-clicking-open-ide

## Batch 1 — 2026-05-01

### Q1: Relay reference wiring
**Context**: The `TunnelHandler` lives in `packages/control-plane` but needs to call `relay.send()` to send `tunnel_open_ack`, `tunnel_data`, and `tunnel_close` messages back to the cloud. Currently the control-plane is a standalone HTTP server with no reference to the relay — the relay lives in `packages/cluster-relay` and is instantiated by the orchestrator.
**Question**: How should the tunnel handler get access to the relay's `send()` method? Should the orchestrator pass a relay reference into the control-plane at startup, or should the handler live in the orchestrator package instead?
**Options**:
- A: Orchestrator passes a `send` callback (or relay reference) to the control-plane tunnel handler at boot
- B: Move the tunnel handler to the orchestrator package (alongside relay construction)
- C: Use a module-level setter pattern (like `setRelayPushEvent` in the control-plane state module)

**Answer**: A — Orchestrator passes a `send` callback (or relay reference) into the control-plane tunnel handler at boot. The orchestrator constructs both the relay and the control-plane HTTP server; injecting the dependency at boot is clean, explicit, and avoids pulling `cluster-relay` into the control-plane package. Concretely: the control-plane's tunnel handler accepts a `RelayMessageSender` interface (just `send(message): Promise<void>`) in its constructor; orchestrator passes `relay.send.bind(relay)`. Module-level setter (option C) works and is established for `setRelayPushEvent`, but explicit injection is more testable and avoids the temporal coupling of "must call setter before first message." Moving the handler to the orchestrator package (option B) couples concerns — the lifecycle of code-server and the tunnel is a control-plane responsibility.

### Q2: Code-server auto-start on tunnel_open
**Context**: `CodeServerProcessManager` in `packages/control-plane/src/services/code-server-manager.ts` manages code-server lifecycle with `start()`, `stop()`, and idle timeout. When a `tunnel_open` arrives, code-server may not yet be running. The handler's behavior differs significantly depending on this choice.
**Question**: Should the tunnel handler auto-start code-server via `CodeServerManager.start()` when it receives `tunnel_open` and code-server is not running, or should it return `tunnel_open_ack { status: 'error' }` and require code-server to be pre-started?
**Options**:
- A: Auto-start code-server on `tunnel_open` (lazy start, best UX)
- B: Fail with error if code-server not running (require explicit start)

**Answer**: A — Auto-start code-server on `tunnel_open` (lazy start). Best UX; eliminates a race condition between the cloud calling `code-server-start` and sending `tunnel_open` immediately after. If the handler arrives before code-server is running, it should call `CodeServerManager.start()`, await readiness, then connect to the socket and send `tunnel_open_ack { status: 'ok' }`. Bound the wait (e.g., 10s); on timeout, send `tunnel_open_ack { status: 'error', error: 'code-server failed to start' }`. The cloud's "Open IDE" flow doesn't need to coordinate two calls — `tunnel_open` becomes the only entry point.

### Q3: Target path restriction
**Context**: The `tunnel_open` message includes a `target` field specifying the Unix socket path. The spec defaults to `/run/code-server.sock`, but doesn't clarify whether arbitrary paths should be accepted. Accepting arbitrary paths from the cloud could be a security concern (connecting to any local socket).
**Question**: Should the `target` path be restricted to known socket paths (e.g., an allowlist or just the code-server socket), or should any path from the cloud be accepted?
**Options**:
- A: Restrict to code-server socket path only (hardcoded or from env)
- B: Allowlist of known socket paths (configurable)
- C: Accept any path the cloud sends (trust the cloud)

**Answer**: A — Restrict `target` to the code-server socket path only. Hardcode the allowed path (`/run/code-server.sock`) in the handler; reject any `tunnel_open` whose `target` differs with `tunnel_open_ack { status: 'error', error: 'invalid target' }`. Accepting arbitrary paths gives a compromised cloud the ability to tunnel into any Unix socket inside the cluster. The single-allowed-path posture is the right v1.5 default. Upgrade to a configurable allowlist if future use cases need other sockets.

### Q4: Relay reconnect tunnel ownership
**Context**: US2 requires tunnels to re-establish after relay WebSocket disconnects and reconnects, but doesn't specify which side is responsible. The cluster-side handler could either maintain tunnel state across reconnects and try to re-open, or be stateless and wait for the cloud to re-send `tunnel_open`.
**Question**: After a relay reconnect, who initiates tunnel re-establishment — does the cloud-side `TunnelManager` re-send `tunnel_open` messages for active IDE sessions, or must the cluster-side track open tunnels and signal readiness?
**Options**:
- A: Cloud re-sends `tunnel_open` (cluster-side is stateless across reconnects)
- B: Cluster-side tracks tunnels and signals readiness on reconnect
- C: Both sides participate (cluster sends inventory, cloud reconciles)

**Answer**: A — Cloud re-sends `tunnel_open`; cluster-side is stateless across reconnects. The browser is the source of truth for active IDE sessions; on relay reconnect, the cloud's `TunnelManager` re-issues `tunnel_open` for active browser sessions. The cluster handler sees a fresh `tunnel_open`, opens a new socket connection, sends `tunnel_open_ack`. Cluster-side bookkeeping is extra complexity for no benefit.

### Q5: Idle timeout interaction with tunnels
**Context**: `CodeServerManager` has an idle timeout (default 30 minutes) that auto-stops code-server. Active tunnel traffic (incoming `tunnel_data`) indicates the IDE is in use. Without resetting the idle timer, code-server could be killed mid-editing session, violating SC-002 (30+ minute session durability).
**Question**: Should incoming `tunnel_data` messages reset the code-server idle timer via `CodeServerManager.touch()` to prevent idle shutdown during active IDE sessions?
**Options**:
- A: Yes, `tunnel_data` resets idle timer (prevents shutdown during active editing)
- B: No, idle timer is independent of tunnel activity

**Answer**: A — Yes, `tunnel_data` resets the code-server idle timer via `CodeServerManager.touch()`. Active tunnel traffic is exactly what "user is using the IDE" means; without this, the 30-min idle timeout can kill an active editing session and violate SC-002. Implement on every inbound `tunnel_data` for tunnels where `target === code-server-socket-path`. The reset should be cheap (just bumping a `lastActivity` timestamp); no need to debounce.
