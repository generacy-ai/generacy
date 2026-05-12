# Research: Fix `codeServerReady` Cross-Process Singleton Bug

**Feature**: #596 | **Date**: 2026-05-12

## Decision: Unix Socket Probe (Option A)

### Approach Selected

**Direct unix socket connection probe** using `node:net` — attempt `net.connect()` to the code-server socket, resolve true on connect, false on error/timeout.

### Alternatives Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| **A. Socket probe** | Zero IPC plumbing; distinguishes alive vs stale socket; no new dependencies | 500ms timeout on `/health` when code-server is down | **Selected** |
| B. Extend control-plane `/state` endpoint | Single source of truth; composes with #594 IPC | More wiring; `/health` depends on control-plane reachability; deferred to #594 | Deferred |
| C. `fs.stat` on socket file | Fastest (no connect overhead) | False positive: socket file exists but code-server has crashed (stale socket) | Rejected |
| D. Cache last probe result in-memory | Avoids async in `collectMetadata` | Cache invalidation complexity; bounded staleness risk | Rejected per clarification Q2 |

### Why Socket Probe Wins

1. **Correctness**: A successful TCP connect proves code-server is alive and accepting connections. `fs.stat` only proves the file exists (stale sockets remain on disk after crashes).
2. **Simplicity**: One function, one dependency (`node:net`), no IPC protocol to maintain.
3. **Performance**: When code-server is running, the connect + immediate end round-trips in < 1ms on localhost unix sockets. The 500ms timeout only applies when code-server is genuinely down — acceptable for a health endpoint.
4. **Fit**: The orchestrator's `/health` handler is already async, so the probe drops in trivially. The async ripple to `relay-bridge.ts` is shallow (3 signature changes + 1 `.catch()`).

### Implementation Pattern

```typescript
import net from 'node:net';

const DEFAULT_SOCKET = '/run/generacy-control-plane/code-server.sock';
const DEFAULT_TIMEOUT = 500;

export async function probeCodeServerSocket(
  socketPath = process.env['CODE_SERVER_SOCKET_PATH'] ?? DEFAULT_SOCKET,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error',   () => { clearTimeout(timer); resolve(false); });
  });
}
```

### Key Design Decisions

1. **`sock.end()` not `sock.destroy()`** on success — sends FIN to gracefully close, avoiding stale connections in code-server's backlog.
2. **Timeout timer** — prevents `/health` from hanging when code-server is in a bad state (e.g., socket exists but process is deadlocked).
3. **No retry** — a single probe per call. Retries are the caller's responsibility (e.g., relay-bridge retries on the next 60s heartbeat cycle).
4. **Default from env** — `CODE_SERVER_SOCKET_PATH` matches the existing convention from #586/#588.

### Async Ripple in relay-bridge.ts

The `collectMetadata()` → `sendMetadata()` → `setInterval` callback chain becomes async:

```typescript
// Before
collectMetadata(): ClusterMetadata { ... }
sendMetadata(): void { ... }
setInterval(() => this.sendMetadata(), 60_000);

// After
async collectMetadata(): Promise<ClusterMetadata> { ... }
async sendMetadata(): Promise<void> { ... }
setInterval(() => { this.sendMetadata().catch(err => logger.warn(...)); }, 60_000);
```

Three function signatures change. One `.catch()` added. No other callers are affected because `sendMetadata` was previously fire-and-forget (void return, called from interval callback).

## References

- Spec: `specs/596-symptoms-after-bootstrap/spec.md`
- #586 PR (added `codeServerReady` field — assumed same-process)
- #594 (same cross-process IPC seam, event direction)
- #588 (changed default socket path to `/run/generacy-control-plane/code-server.sock`)
- Node.js `net.connect` docs: unix socket support
