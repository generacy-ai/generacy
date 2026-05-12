# Clarifications — #586

## Batch 1 (2026-05-12)

### Q1: Dual metadata paths
**Context**: There are two separate metadata collection systems: cluster-relay's `collectMetadata()` in `packages/cluster-relay/src/metadata.ts` (used during WebSocket handshake, fetches from orchestrator HTTP endpoints) and the orchestrator's relay-bridge `collectMetadata()` in `packages/orchestrator/src/services/relay-bridge.ts` (used for periodic metadata messages, runs in-process). FR-003 references only the cluster-relay path, but the relay-bridge path is what sends ongoing metadata updates to the cloud. Adding `codeServerReady` to only one path could mean the field is present at connect time but missing from updates, or vice versa.
**Question**: Should `codeServerReady` be added to both metadata collection paths (cluster-relay handshake AND relay-bridge periodic), or only one? If only one, which?
**Options**:
- A: Both paths — handshake includes it for initial connect, relay-bridge includes it for periodic updates
- B: Relay-bridge only — periodic updates are what matter; handshake metadata is secondary
- C: Cluster-relay only — as the spec currently states

**Answer**: *Pending*

### Q2: Code-server readiness detection method
**Context**: The spec says `collectMetadata` "checks code-server socket existence (or queries the control-plane)." In the cluster-relay path, metadata is collected by HTTP-fetching the orchestrator's `/health` and `/metrics` endpoints — it cannot call `getCodeServerManager()` in-process. In the relay-bridge path, it can call `getCodeServerManager().getStatus()` directly. The detection method depends on which metadata path is chosen (Q1), and each has trade-offs: socket `fs.stat()` is simple but can find stale sockets; querying the manager is accurate but only available in-process; adding a new orchestrator HTTP endpoint is accurate and works from cluster-relay but adds API surface.
**Question**: How should code-server readiness be detected for metadata reporting?
**Options**:
- A: `fs.stat()` on the socket path — simple, works anywhere, but may report stale sockets as ready
- B: Query `CodeServerManager.getStatus() === 'running'` — accurate, but only works in orchestrator (relay-bridge path)
- C: Add a field to the orchestrator's existing `/health` endpoint — works from cluster-relay, accurate, small API change

**Answer**: *Pending*

### Q3: Bootstrap-complete code-server start — sync vs async
**Context**: FR-001 says `bootstrap-complete` triggers `code-server-start`. Currently `bootstrap-complete` only writes a sentinel file and returns immediately. Code-server's `waitForSocket()` has a 10-second timeout. If the start is synchronous, the `bootstrap-complete` response is delayed up to 10s but guarantees the socket exists when the response arrives. If async (fire-and-forget), the response is immediate but `codeServerReady` may not be `true` yet when the user sees the "Open IDE" button.
**Question**: Should the `bootstrap-complete` handler wait for code-server to be ready (socket available) before returning, or start it asynchronously?
**Options**:
- A: Synchronous — wait for socket (up to 10s timeout), guarantees readiness on response
- B: Asynchronous — fire-and-forget, rely on metadata heartbeat to eventually flip `codeServerReady` to true
- C: Async start, but emit a relay event when code-server becomes ready (so cloud can update immediately without waiting for next heartbeat)

**Answer**: *Pending*
