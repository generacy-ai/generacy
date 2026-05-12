# Bug Fix: Orchestrator `/health` always reports `codeServerReady: false`

Cross-process singleton mismatch: orchestrator queries its own `CodeServerManager` instance, but code-server is started by the control-plane process.

**Branch**: `596-symptoms-after-bootstrap` | **Issue**: [#596](https://github.com/generacy-ai/generacy/issues/596) | **Date**: 2026-05-12 | **Status**: Draft

## Summary

After bootstrap completes, the "Open IDE" button is permanently disabled. Code-server is running (started by the control-plane process), but the orchestrator's `/health` endpoint reports `codeServerReady: false` because it queries a module-scoped `CodeServerManager` singleton that belongs to a different process. The metadata pipeline (`/health` -> relay metadata -> Firestore -> SSE -> frontend) never propagates `true`, so the button stays disabled.

## Root Cause

`packages/orchestrator/src/routes/health.ts` calls `getCodeServerManager()?.getStatus() === 'running'` — but the orchestrator and control-plane are separate Node.js processes with independent module-scoped singletons. The control-plane started code-server (its singleton is `'running'`), but the orchestrator's singleton was never told to start anything (remains `'stopped'`).

## Chosen Approach: Unix Socket Connection Probe (Option A)

Replace the in-process singleton query with a direct TCP connection probe against code-server's Unix socket. If a connection succeeds, code-server is alive; if it fails or times out, it's not.

```typescript
import net from 'node:net';

async function probeCodeServerSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}
```

**Why this over querying control-plane's `/state`**: Zero IPC plumbing, no dependency on control-plane availability, correctly distinguishes live socket from stale file (unlike `fs.stat`). The 500ms worst-case timeout when code-server is down is acceptable for `/health`.

## User Stories

### US1: Developer opens IDE after bootstrap

**As a** developer who just completed the bootstrap wizard,
**I want** the "Open IDE" button to enable automatically once code-server is running,
**So that** I can start coding without manual intervention or page refreshes.

**Acceptance Criteria**:
- [ ] `/health` returns `codeServerReady: true` when code-server's Unix socket accepts connections
- [ ] `/health` returns `codeServerReady: false` (without hanging) when code-server is not running
- [ ] "Open IDE" button enables within seconds of code-server starting

### US2: Metadata pipeline reflects actual code-server state

**As a** cloud service consuming cluster metadata,
**I want** the `codeServerReady` field in metadata to accurately reflect whether code-server is accepting connections,
**So that** the frontend can reliably gate IDE access.

**Acceptance Criteria**:
- [ ] Relay metadata includes correct `codeServerReady` value from `/health`
- [ ] Firestore cluster doc updates to `codeServerReady: true` after bootstrap-complete

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace `getCodeServerManager()?.getStatus()` with Unix socket connection probe in `/health` handler | P1 | `packages/orchestrator/src/routes/health.ts` |
| FR-002 | Socket path from `CODE_SERVER_SOCKET_PATH` env var, default `/run/generacy-control-plane/code-server.sock` | P1 | Matches #588 default |
| FR-003 | Probe timeout of 500ms — resolve `false` on timeout or connection error | P1 | Bounded worst-case latency |
| FR-004 | `/health` handler becomes async (if not already) to await probe result | P2 | May require minor handler signature change |
| FR-005 | Remove or bypass `getCodeServerManager()` import in health route (dead code for this field) | P2 | Clean up unused singleton query |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `/health` accuracy | `codeServerReady` matches actual code-server liveness | Probe running socket -> `true`; probe absent/dead socket -> `false` |
| SC-002 | `/health` latency (code-server up) | < 10ms | Connection to local Unix socket is near-instant |
| SC-003 | `/health` latency (code-server down) | < 600ms | Bounded by 500ms probe timeout + overhead |
| SC-004 | End-to-end | "Open IDE" button enables after bootstrap | Manual test on fresh cluster |

## Test Plan

- [ ] Unit: `probeCodeServerSocket` returns `true` when connected to a live Unix socket
- [ ] Unit: `probeCodeServerSocket` returns `false` on non-existent socket path (no hang)
- [ ] Unit: `probeCodeServerSocket` returns `false` on stale socket file (ECONNREFUSED)
- [ ] Integration: `/health` returns `codeServerReady: true` after code-server is started by control-plane
- [ ] Integration: `/health` returns `codeServerReady: false` before code-server starts
- [ ] E2E: After bootstrap-complete, Firestore cluster doc shows `codeServerReady: true`
- [ ] E2E: "Open IDE" button enables and loads code-server iframe

## Assumptions

- Orchestrator and control-plane share the same filesystem (can access the Unix socket)
- `CODE_SERVER_SOCKET_PATH` default of `/run/generacy-control-plane/code-server.sock` is correct (set in #588)
- The `/health` endpoint is called frequently enough (heartbeat interval) that a brief probe delay is acceptable

## Out of Scope

- Option B (control-plane `/state` API extension) — deferred to #594 IPC consolidation
- Broader cross-process state sharing architecture — tracked under #572
- VS Code tunnel readiness probing — same pattern but separate issue

## Related Issues

- #586 / #587 — Added `codeServerReady` field (assumed same-process; this issue is the resulting gap)
- #594 — Same cross-process IPC seam (event direction)
- #572 — Cluster-to-cloud contract umbrella

---

*Generated by speckit*
