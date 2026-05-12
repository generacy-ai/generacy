# Research: Open IDE Flow Fix (#586)

## Technology Decisions

### 1. Fire-and-Forget Code-Server Start

**Decision**: Async start (no await) with out-of-band metadata push.

**Alternatives considered**:
- **Synchronous start** (await in bootstrap-complete handler): Blocks response up to 10s. Rejected because bootstrap-complete should return fast; the sentinel file triggers post-activation scripts that shouldn't be delayed.
- **Async start + 60s heartbeat**: User waits up to 60s for button to enable. Rejected for poor UX.
- **Chosen: Async start + callback-triggered `sendMetadata()`**: Response returns immediately. Code-server status propagates within seconds via out-of-band metadata send. Best of both worlds.

### 2. Code-Server Readiness Detection

**Decision**: `CodeServerManager.getStatus() === 'running'` as source of truth.

**Alternatives considered**:
- **`fs.stat()` on socket path**: Simple but dangerous — Unix sockets survive process crashes. A stale `/run/code-server.sock` would falsely report `codeServerReady: true`. Rejected.
- **New HTTP endpoint on code-server**: Over-engineered. Code-server doesn't expose a health check on the socket. Rejected.
- **Chosen: Manager status**: `CodeServerProcessManager` tracks `status` through `stopped → starting → running` transitions. The `running` state is set only after `waitForSocket()` confirms the socket is live *and* the spawned process hasn't exited. Accurate, no I/O overhead, and already accessible via singleton.

### 3. Relay Route Pattern

**Decision**: Add `{ prefix: '/code-server', target: 'unix:///run/code-server.sock' }` to relay client routes.

**Pattern**: Identical to #574 fix for `/control-plane` route. The dispatcher in `cluster-relay/src/dispatcher.ts` uses longest-prefix-match and strips the prefix before forwarding. This means `/code-server/stable-abc123/?folder=/workspaces/project` becomes `/stable-abc123/?folder=/workspaces/project` on the socket — exactly what code-server expects.

**Why not a new relay message type**: Cloud's IDE proxy already uses the HTTP-over-relay path (`api_request` messages). Adding a dedicated message type would require cloud-side changes. The route-based approach requires zero cloud changes.

### 4. Dual Metadata Paths

**Decision**: Wire `codeServerReady` through both `cluster-relay/metadata.ts` (handshake) and `relay-bridge.ts` (periodic).

**Rationale**: These two paths exist because of historical architecture (#572 tracks consolidation). If only one path includes the field, reconnection scenarios can cause the cloud to lose the field. Example: if relay-bridge includes it but cluster-relay doesn't, then after a WebSocket disconnect + reconnect, the handshake metadata would drop `codeServerReady` until the next periodic update (up to 60s).

### 5. Callback vs EventEmitter for State Transition Notification

**Decision**: Simple callback setter on `CodeServerManager`.

**Alternatives considered**:
- **EventEmitter**: Over-engineered for a single listener. Adds `events` dependency to control-plane types.
- **Observable/RxJS**: Way over-engineered. No RxJS in the codebase.
- **Chosen: `onStatusChange(callback)` setter**: Follows existing patterns (`setRelayPushEvent`, `setLeaseManager`, etc.). Single callback, replaced on each call. Clean, minimal, testable.

## Implementation Patterns

### Existing Patterns to Follow

1. **Relay route registration** (`server.ts:640-645`): Add entry to `routes` array. Prefix-match dispatcher handles the rest.

2. **Health endpoint extension** (`routes/health.ts`): Add field to existing response object. Consumers that don't read it are unaffected (Zod `passthrough()` or optional field).

3. **Singleton getter pattern** (`getCodeServerManager()`): Already used in lifecycle.ts, tunnel-handler.ts, server.ts. Just call it where needed.

4. **Metadata collection** (`relay-bridge.ts:493-514`): Add field to returned object. Cloud's `cluster-registration.ts` passes `...metadata` through without filtering.

5. **Fire-and-forget with error logging** (common pattern in control-plane): `.catch(err => logger.error(...))`. Don't let secondary operations fail primary flows.

## Key Sources

- #574: Control-plane route registration fix — identical pattern for `/code-server` route
- #572: Cluster-cloud contract umbrella — tracks metadata path consolidation (out of scope)
- `cluster-relay/src/dispatcher.ts`: Route resolution and prefix stripping logic
- `control-plane/src/services/code-server-manager.ts`: CodeServerProcessManager state machine
- Cloud's `ide-proxy.ts:140`: Confirms cloud forwards with `/code-server${subPath}` prefix
