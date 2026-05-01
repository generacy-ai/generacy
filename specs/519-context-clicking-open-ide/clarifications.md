# Clarifications: 519-context-clicking-open-ide

## Batch 1 — 2026-05-01

### Q1: Relay reference wiring
**Context**: The `TunnelHandler` lives in `packages/control-plane` but needs to call `relay.send()` to send `tunnel_open_ack`, `tunnel_data`, and `tunnel_close` messages back to the cloud. Currently the control-plane is a standalone HTTP server with no reference to the relay — the relay lives in `packages/cluster-relay` and is instantiated by the orchestrator.
**Question**: How should the tunnel handler get access to the relay's `send()` method? Should the orchestrator pass a relay reference into the control-plane at startup, or should the handler live in the orchestrator package instead?
**Options**:
- A: Orchestrator passes a `send` callback (or relay reference) to the control-plane tunnel handler at boot
- B: Move the tunnel handler to the orchestrator package (alongside relay construction)
- C: Use a module-level setter pattern (like `setRelayPushEvent` in the control-plane state module)

**Answer**: *Pending*

### Q2: Code-server auto-start on tunnel_open
**Context**: `CodeServerProcessManager` in `packages/control-plane/src/services/code-server-manager.ts` manages code-server lifecycle with `start()`, `stop()`, and idle timeout. When a `tunnel_open` arrives, code-server may not yet be running. The handler's behavior differs significantly depending on this choice.
**Question**: Should the tunnel handler auto-start code-server via `CodeServerManager.start()` when it receives `tunnel_open` and code-server is not running, or should it return `tunnel_open_ack { status: 'error' }` and require code-server to be pre-started?
**Options**:
- A: Auto-start code-server on `tunnel_open` (lazy start, best UX)
- B: Fail with error if code-server not running (require explicit start)

**Answer**: *Pending*

### Q3: Target path restriction
**Context**: The `tunnel_open` message includes a `target` field specifying the Unix socket path. The spec defaults to `/run/code-server.sock`, but doesn't clarify whether arbitrary paths should be accepted. Accepting arbitrary paths from the cloud could be a security concern (connecting to any local socket).
**Question**: Should the `target` path be restricted to known socket paths (e.g., an allowlist or just the code-server socket), or should any path from the cloud be accepted?
**Options**:
- A: Restrict to code-server socket path only (hardcoded or from env)
- B: Allowlist of known socket paths (configurable)
- C: Accept any path the cloud sends (trust the cloud)

**Answer**: *Pending*

### Q4: Relay reconnect tunnel ownership
**Context**: US2 requires tunnels to re-establish after relay WebSocket disconnects and reconnects, but doesn't specify which side is responsible. The cluster-side handler could either maintain tunnel state across reconnects and try to re-open, or be stateless and wait for the cloud to re-send `tunnel_open`.
**Question**: After a relay reconnect, who initiates tunnel re-establishment — does the cloud-side `TunnelManager` re-send `tunnel_open` messages for active IDE sessions, or must the cluster-side track open tunnels and signal readiness?
**Options**:
- A: Cloud re-sends `tunnel_open` (cluster-side is stateless across reconnects)
- B: Cluster-side tracks tunnels and signals readiness on reconnect
- C: Both sides participate (cluster sends inventory, cloud reconciles)

**Answer**: *Pending*

### Q5: Idle timeout interaction with tunnels
**Context**: `CodeServerManager` has an idle timeout (default 30 minutes) that auto-stops code-server. Active tunnel traffic (incoming `tunnel_data`) indicates the IDE is in use. Without resetting the idle timer, code-server could be killed mid-editing session, violating SC-002 (30+ minute session durability).
**Question**: Should incoming `tunnel_data` messages reset the code-server idle timer via `CodeServerManager.touch()` to prevent idle shutdown during active IDE sessions?
**Options**:
- A: Yes, `tunnel_data` resets idle timer (prevents shutdown during active editing)
- B: No, idle timer is independent of tunnel activity

**Answer**: *Pending*
