# Feature Specification: ## Symptoms

After bootstrap completes, the "Open IDE" button is permanently disabled across multiple fresh test projects

**Branch**: `596-symptoms-after-bootstrap` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

## Symptoms

After bootstrap completes, the "Open IDE" button is permanently disabled across multiple fresh test projects. Verified on a live cluster:

\`\`\`
$ docker exec <orchestrator> ps aux | grep code-server
node 914 ... --socket /run/generacy-control-plane/code-server.sock --auth none  ✓ running

$ docker exec <orchestrator> curl -s http://127.0.0.1:3100/health
{"status":"ok","services":{"server":"ok"},"codeServerReady":false}    ✗ wrong
\`\`\`

Code-server IS running, but \`/health\` says no — so the cluster metadata payload reports \`codeServerReady: false\`, the cloud Firestore cluster doc never flips to true, the SSE event never fires, and the frontend's \`cluster?.codeServerReady === true\` gate keeps the Open IDE button permanently disabled.

## Root cause

[\`packages/orchestrator/src/routes/health.ts:87\`](packages/orchestrator/src/routes/health.ts#L87):

\`\`\`typescript
const codeServerReady = getCodeServerManager()?.getStatus() === 'running';
\`\`\`

This calls \`getCodeServerManager()\` **in the orchestrator process**. But code-server was started by the **control-plane process** (a separate child process — see bootstrap-complete handler in [\`packages/control-plane/src/routes/lifecycle.ts:97-118\`](packages/control-plane/src/routes/lifecycle.ts#L97-L118)). The two processes import the same module but have independent module-scoped singletons. The orchestrator's \`CodeServerManager\` instance has never been told to start anything, so its status is \`'stopped'\` — even though the control-plane's instance is happily running.

This is structurally the same problem as generacy-ai/generacy#594, but in the opposite direction: that one is "control-plane → orchestrator events," this one is "control-plane → orchestrator state queries."

## Fix

Two reasonable options:

### A. Connection probe on the unix socket (simplest)

In [\`packages/orchestrator/src/routes/health.ts\`](packages/orchestrator/src/routes/health.ts):

\`\`\`typescript
import net from 'node:net';

async function probeCodeServerSocket(socketPath: string, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once('connect', () => { clearTimeout(timer); sock.end(); resolve(true); });
    sock.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// In the handler:
const socketPath = process.env['CODE_SERVER_SOCKET_PATH']
  ?? '/run/generacy-control-plane/code-server.sock';
const codeServerReady = await probeCodeServerSocket(socketPath);
\`\`\`

Pros: zero IPC plumbing, distinguishes alive (CONNECT succeeds) from stale-socket (ECONNREFUSED with file present) cleanly. Avoids the \`fs.stat\` false-positive that I argued against in #586's Q2.

Cons: 500ms timeout (or whatever value) on every \`/health\` call when code-server is down — bounded but not free. Probably fine in practice.

### B. Extend control-plane's \`/state\` and have orchestrator query it (architecturally cleaner)

The control-plane already exposes [\`GET /state\`](packages/control-plane/src/routes/state.ts) returning lifecycle status. Add a \`codeServer.status\` field that mirrors \`CodeServerManager.getStatus()\` from the right singleton. The orchestrator's \`/health\` handler then queries control-plane via its unix socket.

This pairs nicely with #594 — once the control-plane has a documented "what's running" API, future state queries (vscode-tunnel, etc.) can use the same pattern instead of each one reinventing IPC.

Pros: single source of truth, composes with #594's IPC channel.

Cons: more wiring; \`/health\` now depends on control-plane being reachable (graceful degradation needed: treat unreachable control-plane as \`codeServerReady: false\` rather than throwing).

I'd ship **A** for v1 (fastest path to unblocking the Open IDE button) and revisit B as part of a broader cluster-internal state-query consolidation when #594 lands and proves out the IPC pattern.

## Broader pattern note

This is now the third recurring "control-plane and orchestrator are separate processes that need to share state/events" bug in the past two days:

- #586 (\`codeServerReady\` field producer) — assumed same process
- #594 (relay event push) — same problem in the event direction
- This one — same problem in the state-query direction

All three patches the same architectural seam. Worth tracking under #572 (cluster ↔ cloud contract umbrella) — when the implementer touches the IPC for #594, this issue's fix probably has the same shape. Could be one PR.

## Test plan
- [ ] After fix, with code-server running: \`/health\` returns \`codeServerReady: true\` within ~10ms
- [ ] With code-server NOT running: \`/health\` returns \`codeServerReady: false\` and doesn't hang past the probe timeout
- [ ] After cluster boot + bootstrap-complete: cloud Firestore cluster doc shows \`codeServerReady: true\`
- [ ] Frontend's "Open IDE" button enables; clicking it loads code-server in an iframe attached to the cluster's \`/workspaces/<project>\` directory

## Diagnostic context

\`\`\`
$ docker exec onboarding-test-5-orchestrator-1 ls -la /run/generacy-control-plane/code-server.sock
srw-rw---- 1 node node 0 May 12 16:14 code-server.sock   # alive

$ docker exec onboarding-test-5-orchestrator-1 ps aux | grep code-server | head -1
node  914  /usr/local/lib/code-server-4.96.4/lib/node ... --socket /run/generacy-control-plane/code-server.sock

$ docker exec onboarding-test-5-orchestrator-1 curl -s http://127.0.0.1:3100/health | jq .codeServerReady
false
\`\`\`

## Related
- #586 / #587 (added the \`codeServerReady\` producer — assumed same-process, this issue is the resulting gap)
- #594 (same cross-process IPC seam, event direction)
- #572 (cluster ↔ cloud contract umbrella)

## User Stories

### US1: Open IDE after bootstrap

**As a** developer who just completed cluster bootstrap,
**I want** the "Open IDE" button to enable automatically,
**So that** I can start coding immediately without manual intervention.

**Acceptance Criteria**:
- [ ] `/health` returns `codeServerReady: true` when code-server's unix socket is accepting connections
- [ ] `/health` returns `codeServerReady: false` (without hanging) when code-server is not running
- [ ] Periodic metadata heartbeat in relay-bridge also reports correct `codeServerReady` value
- [ ] Cloud Firestore cluster doc reflects `codeServerReady: true` after bootstrap-complete
- [ ] Frontend "Open IDE" button enables and loads code-server

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace `getCodeServerManager()?.getStatus()` in `health.ts` with async unix socket probe | P1 | Probes `/run/generacy-control-plane/code-server.sock` with ~500ms timeout |
| FR-002 | Replace `getCodeServerManager()?.getStatus()` in `relay-bridge.ts` `collectMetadata()` with same probe | P1 | Same root cause — cross-process singleton fallacy |
| FR-003 | Extract shared `probeCodeServerAlive()` helper | P1 | `packages/orchestrator/src/services/code-server-probe.ts` — single source of truth for both callsites |
| FR-004 | Make `collectMetadata()` and `sendMetadata()` async | P2 | Shallow ripple: 3 function signatures + `.catch()` on interval callback |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `/health` accuracy | `codeServerReady` matches actual socket state | Socket probe returns true when code-server accepts connections, false otherwise |
| SC-002 | Probe latency | < 10ms when code-server is running, < 500ms timeout when not | Time the `/health` endpoint response |
| SC-003 | End-to-end | "Open IDE" button enables after bootstrap | Fresh project bootstrap → button clickable → code-server loads |

## Assumptions

- Code-server binds to `/run/generacy-control-plane/code-server.sock` (configurable via `CODE_SERVER_SOCKET_PATH`)
- A successful TCP connect to the unix socket means code-server is ready to serve
- The cluster-relay `collectMetadata` in `packages/cluster-relay/src/metadata.ts` reads from `/health` over HTTP, so it's fixed transitively once `/health` is correct

## Out of Scope

- Option B (extending control-plane `/state` endpoint) — deferred to #594 IPC consolidation
- VS Code tunnel readiness probing (separate pattern)
- Cache-based approaches for `collectMetadata` (rejected in clarification — async is simpler)

---

*Generated by speckit*
