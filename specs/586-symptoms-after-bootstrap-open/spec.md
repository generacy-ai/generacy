# Feature Specification: ## Symptoms

After bootstrap, the "Open IDE" button on the ReadyStep:
- Sometimes briefly appears enabled, then becomes permanently disabled after refresh

**Branch**: `586-symptoms-after-bootstrap-open` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

## Symptoms

After bootstrap, the "Open IDE" button on the ReadyStep:
- Sometimes briefly appears enabled, then becomes permanently disabled after refresh.
- When clicked (during the brief window), opens a tab at \`vscode.dev/tunnel/<clusterId>\` — Microsoft's VS Code for the Web connected to a tunnel. Because that tunnel was registered against the user's Windows host (per #584), the IDE shows the host's filesystem (\`C:\\Users\\...\`) instead of the cluster's \`/workspaces/\`.

## Root cause — three independent gaps stacking

### A. No code path on the cluster ever sets \`codeServerReady\`

- Cluster metadata reported via [\`packages/cluster-relay/src/metadata.ts:18-26\`](packages/cluster-relay/src/metadata.ts#L18-L26) includes \`workerCount, activeWorkflows, channel, orchestratorVersion, gitRemotes, uptime\` — and **not** \`codeServerReady\`.
- Cluster registration in cloud ([\`services/api/src/services/cluster-registration.ts:145-166\`](https://github.com/generacy-ai/generacy-cloud/blob/main/services/api/src/services/cluster-registration.ts#L145-L166)) never receives the field, so the Firestore cluster doc has \`codeServerReady: undefined\`.
- Web hook ([\`packages/web/src/lib/hooks/use-cluster-status.ts:136\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/lib/hooks/use-cluster-status.ts#L136)) reads it from the SSE event; it's always undefined.
- ReadyStep gates the button with \`cluster?.codeServerReady === true\` → false forever → button permanently disabled.

Schema and plumbing for the field exist top-to-bottom in cloud and web. There's just no producer on the cluster.

### B. The cluster's relay client has no route for \`/code-server\`

Cloud's IDE proxy forwards through the relay with path \`/code-server\${subPath}\` ([\`services/api/src/routes/clusters/ide-proxy.ts:140\`](https://github.com/generacy-ai/generacy-cloud/blob/main/services/api/src/routes/clusters/ide-proxy.ts#L140)).

The orchestrator constructs the relay client with only one route ([\`packages/orchestrator/src/server.ts:640-645\`](packages/orchestrator/src/server.ts#L640-L645)):

\`\`\`typescript
routes: [
  { prefix: '/control-plane', target: \`unix://\${controlPlaneSocket}\` },
],
\`\`\`

No \`/code-server → unix:///run/code-server.sock\` entry. So when the cloud forwards IDE traffic, the cluster-relay falls back to HTTP-proxying to the orchestrator's Fastify on \`127.0.0.1:3100\`, which has no \`/code-server/*\` handler → 404. (We saw the same shape in the control-plane bug #574 before fixing it.)

### C. Code-server is never started in the cluster

The control-plane has [\`code-server-manager.ts\`](packages/control-plane/src/services/code-server-manager.ts) and a \`code-server-start\` lifecycle action ([\`packages/control-plane/src/routes/lifecycle.ts:26\`](packages/control-plane/src/routes/lifecycle.ts#L26)). Nothing in the bootstrap flow calls it. Even if A and B were fixed, the unix socket at \`/run/code-server.sock\` wouldn't exist.

## Proposed fix

Three matching changes:

1. **Control-plane `bootstrap-complete` handler** triggers `code-server-start` asynchronously (fire-and-forget). The `bootstrap-complete` response returns immediately; code-server readiness is communicated out-of-band via metadata (see #3). If code-server fails to start, the manager transitions to `error` state and metadata reports `codeServerReady: false` — the button stays disabled but bootstrap itself is not failed.
2. **packages/orchestrator/src/server.ts** `initializeRelayBridge` adds a second route entry:
   ```typescript
   { prefix: '/code-server', target: \`unix://\${codeServerSocket}\` },
   ```
   where `codeServerSocket` resolves to `process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/code-server.sock'`.
3. **Both metadata collection paths** include `codeServerReady`:
   - **`packages/cluster-relay/src/metadata.ts`** `collectMetadata` reads `codeServerReady` from the orchestrator's `/health` endpoint (new field added to the existing health response — same `fetchHealth` pattern already used for `version`, `channel`, `uptime`). This covers handshake/reconnect metadata.
   - **`packages/orchestrator/src/services/relay-bridge.ts`** `collectMetadata` queries `CodeServerManager.getStatus() === 'running'` directly in-process (the accurate source of truth). This covers periodic metadata updates.
   - **Out-of-band metadata send**: On `CodeServerManager` state transition to `running`, the orchestrator triggers `RelayBridge.sendMetadata()` via a callback wired in `initializeRelayBridge`. This ensures the cloud sees `codeServerReady: true` within a relay round-trip (~seconds), not up to 60s (the default heartbeat interval). Cloud's existing SSE channel broadcasts metadata updates — no new event type needed.
   - The orchestrator's `/health` endpoint gains a `codeServerReady` boolean field, backed by `CodeServerManager.getStatus()`. This avoids `fs.stat()` on the socket (stale sockets after crashes would falsely report ready).

## Test plan
- [ ] After cluster boot: \`docker exec <orchestrator> ls -la /run/code-server.sock\` shows the socket
- [ ] Cluster doc in Firestore has \`codeServerReady: true\` after a fresh launch
- [ ] Open IDE button renders enabled; clicking opens \`staging.generacy.ai/orgs/.../ide\` (not vscode.dev/tunnel)
- [ ] The iframe shows the cluster's \`/workspaces/<project>\` directory (not the Windows host)

## Related
- #584 (VS Code Desktop tunnel binds to host — separate but contributes to the Windows-host symptom when the deep-link falls back to vscode.dev)
- #574 (control-plane route registration — same architectural pattern, fixed there; replicate for code-server)
- #572 (cluster ↔ cloud contract umbrella)

## User Stories

### US1: Open IDE after bootstrap

**As a** developer who just completed cluster bootstrap,
**I want** the "Open IDE" button to be enabled and functional,
**So that** I can start working in the cluster's code-server IDE immediately.

**Acceptance Criteria**:
- [ ] Code-server starts automatically after `bootstrap-complete`
- [ ] `codeServerReady: true` propagates to cloud within seconds (not 60s heartbeat)
- [ ] "Open IDE" button is enabled on ReadyStep when code-server is ready
- [ ] Clicking "Open IDE" opens the cluster's code-server (not vscode.dev/tunnel)
- [ ] The IDE shows the cluster's `/workspaces/<project>` directory

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `bootstrap-complete` lifecycle handler triggers `code-server-start` (async, fire-and-forget) | P1 | Keeps bootstrap-complete response fast |
| FR-002 | `initializeRelayBridge` registers `/code-server` route to `unix:///run/code-server.sock` | P1 | Same pattern as #574 `/control-plane` route |
| FR-003 | Orchestrator `/health` endpoint exposes `codeServerReady` boolean from `CodeServerManager.getStatus()` | P1 | Source of truth for cluster-relay metadata path |
| FR-004 | `cluster-relay/metadata.ts` `collectMetadata` reads `codeServerReady` from `/health` response | P1 | Handshake/reconnect metadata |
| FR-005 | `relay-bridge.ts` `collectMetadata` reads `codeServerReady` from `CodeServerManager.getStatus()` in-process | P1 | Periodic metadata updates |
| FR-006 | `CodeServerManager` state transition to `running` triggers out-of-band `RelayBridge.sendMetadata()` | P1 | Enables seconds-latency status propagation |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Code-server socket exists after bootstrap | `/run/code-server.sock` present | `docker exec <orchestrator> ls -la /run/code-server.sock` |
| SC-002 | Firestore `codeServerReady` field | `true` after fresh launch | Check cluster doc in Firestore |
| SC-003 | "Open IDE" button state | Enabled on ReadyStep | Visual check in bootstrap wizard |
| SC-004 | IDE target | Cluster `/workspaces/<project>` | Open IDE, verify filesystem |

## Assumptions

- Cloud-side schema and plumbing for `codeServerReady` already exist top-to-bottom (Firestore field, SSE event, ReadyStep gate)
- `CodeServerManager` is accessible from the orchestrator process (already used by `TunnelHandler`)
- The orchestrator's `/health` endpoint is extensible (add fields to existing response)
- Cloud's `cluster-registration.ts` passes `...metadata` through without filtering, so new metadata fields propagate automatically

## Out of Scope

- Consolidating the two `collectMetadata` paths (tracked under #572)
- VS Code Desktop tunnel binding to host (#584 — separate issue)
- Code-server idle timeout UX (button re-disabling after 30min idle)
- Cloud-side changes (schema already exists)

---

*Generated by speckit*
