# Research: Control-Plane Daemon Crash Resilience

**Feature**: #624 | **Date**: 2026-05-15

## Pattern Analysis

### 1. Existing Socket Probing Pattern

The codebase has an established pattern in `packages/orchestrator/src/services/code-server-probe.ts`:

```typescript
export function probeCodeServerSocket(socketPath?, timeoutMs?): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(path);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeout);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}
```

**Decision**: Mirror this exactly for `probeControlPlaneSocket()`. Same signature, same timeout default (500ms), same env var override pattern. No abstraction — two independent probe functions is simpler than a generic factory for two call sites.

**Alternatives rejected**:
- Generic `probeSocket(name, defaultPath)` factory: Over-abstraction for 2 uses. Each has its own env var and default path.
- HTTP health check against control-plane: Requires the daemon to be fully initialized. Socket probe detects "process started and bound" which is sufficient.

### 2. Store Fallback Strategy

**Decision**: EACCES catch → try `/tmp/generacy-app-config/` → disabled mode if both fail.

The fallback follows Node.js `fs.mkdir({ recursive: true })` semantics — it won't throw if the directory already exists. The catch is specifically for `EACCES` (and `EPERM` for completeness); other errors (e.g., `ENOSPC`) should still propagate as they indicate system-level issues.

**Error codes to catch**: `EACCES`, `EPERM`, `EROFS` (read-only filesystem).
**Error codes to propagate**: Everything else (`ENOSPC`, `EIO`, etc.).

**Alternatives rejected**:
- Pre-check with `fs.access()` before `fs.mkdir()`: TOCTOU race. Just try and catch.
- Use `os.tmpdir()` instead of hardcoded `/tmp/`: In containers, `os.tmpdir()` returns `/tmp/` anyway. Hardcoding is simpler and matches the spec.

### 3. Disabled Mode Implementation

**Decision**: Boolean flag pattern with guard checks in `set()` and `getAll()`.

```typescript
private disabled = false;
private disabledReason?: string;

async set(entries): Promise<void> {
  if (this.disabled) {
    throw new StoreDisabledError('app-config-store-disabled', this.disabledReason);
  }
  // ... normal implementation
}

async getAll(): Promise<EnvEntry[]> {
  if (this.disabled) return [];
  // ... normal implementation
}
```

The route handler maps `StoreDisabledError` to 503 with `{ error: 'app-config-store-disabled', reason }`. This is consistent with the codebase's existing error-to-HTTP mapping pattern in control-plane routes.

**Alternatives rejected**:
- Null Object pattern (separate `DisabledAppConfigEnvStore` class): More code, same behavior. A flag is simpler for a binary state.
- Middleware-level guard: Disabled state is per-store, not per-route. Store-level guards are more precise.

### 4. Startup Socket-Wait Strategy

**Decision**: Poll loop in `server.ts` with configurable timeout, followed by error status push and grace exit.

```
server.listen() → poll probeControlPlaneSocket() every 1s
  → success within timeout → proceed with relay bridge init
  → timeout → push error status via relay → wait 30s → process.exit(1)
```

**Why poll in server.ts, not the shell script?**
- The shell script is in cluster-base repo (out of scope)
- Node.js code is testable with Vitest
- The error status push requires the relay client, which lives in the Node.js process

**Why not use `fs.watch()` on the socket path?**
- `fs.watch()` on Unix sockets is unreliable across filesystems (tmpfs, overlayfs)
- Poll loop at 1s interval is negligible overhead and predictable

**Grace window**: 30s matches Docker healthcheck `start_period` convention. It's enough for:
1. Relay WebSocket connection establishment (~2-5s with backoff)
2. Error status message transmission (~100ms)
3. Cloud processing and UI update (~1-2s)

### 5. Init Result Surface Area

**Decision**: Relay metadata is the primary exposure channel. The init result is embedded in `ClusterMetadataPayload` sent on handshake and periodic heartbeat.

**Flow**:
1. Control-plane daemon logs structured init results to stderr (JSON lines)
2. Daemon exposes init results via a module-scoped getter
3. Orchestrator cannot read daemon's module state (separate process)
4. Instead: orchestrator queries control-plane via HTTP (new internal endpoint or piggyback on existing)
5. If control-plane is dead: `controlPlaneReady: false` is sufficient — init result unavailable

**Alternative for cross-process init result sharing**:
- Write init result to a well-known file (e.g., `/run/generacy-control-plane/init-result.json`)
- Orchestrator reads the file for metadata
- Simpler than adding an HTTP endpoint; file survives daemon restart

**Decision**: File-based approach for init result sharing. Write `/run/generacy-control-plane/init-result.json` atomically (temp+rename) at end of daemon init. Orchestrator reads it for relay metadata. Avoids coupling to daemon health endpoint.

### 6. Relay Metadata Schema Extension

**Decision**: Optional fields only — backwards compatible.

```typescript
interface ClusterMetadataPayload {
  // ... existing fields ...
  controlPlaneReady?: boolean;
  initResult?: {
    stores: Record<string, 'ok' | 'fallback' | 'disabled'>;
    warnings: string[];
  };
}
```

Cloud-side ignores unknown fields (confirmed by existing pattern: `codeServerReady` was added without cloud schema changes). The cloud companion issue (generacy-cloud#586) will read these fields when ready.

## References

- `probeCodeServerSocket()`: `packages/orchestrator/src/services/code-server-probe.ts`
- Health endpoint: `packages/orchestrator/src/routes/health.ts`
- Relay metadata: `packages/orchestrator/src/services/relay-bridge.ts:collectMetadata()`
- Cluster metadata type: `packages/orchestrator/src/types/relay.ts:ClusterMetadataPayload`
- Control-plane entrypoint: `packages/control-plane/bin/control-plane.ts`
- AppConfigEnvStore: `packages/control-plane/src/services/app-config-env-store.ts`
- AppConfigFileStore: `packages/control-plane/src/services/app-config-file-store.ts`
- Status state machine: `packages/control-plane/src/state.ts`
