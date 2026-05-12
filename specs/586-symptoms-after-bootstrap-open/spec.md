# Bug Fix: "Open IDE" flow non-functional end-to-end after bootstrap

**Branch**: `586-symptoms-after-bootstrap-open` | **Date**: 2026-05-12 | **Status**: Draft | **Issue**: #586

## Summary

The "Open IDE" button on the bootstrap wizard's ReadyStep is permanently disabled because three independent gaps stack: (A) no cluster code path ever sets `codeServerReady` in relay metadata, (B) the relay client has no `/code-server` route so IDE proxy traffic 404s, and (C) code-server is never started during bootstrap so the unix socket doesn't exist. Fixing all three restores the end-to-end IDE launch flow.

## Symptoms

After bootstrap, the "Open IDE" button on the ReadyStep:
- Sometimes briefly appears enabled, then becomes permanently disabled after refresh.
- When clicked (during the brief window), opens a tab at `vscode.dev/tunnel/<clusterId>` — Microsoft's VS Code for the Web connected to a tunnel. Because that tunnel was registered against the user's Windows host (per #584), the IDE shows the host's filesystem (`C:\Users\...`) instead of the cluster's `/workspaces/`.

## Root Cause Analysis

### A. No code path on the cluster ever sets `codeServerReady`

- Cluster metadata reported via `packages/cluster-relay/src/metadata.ts:18-26` includes `workerCount, activeWorkflows, channel, orchestratorVersion, gitRemotes, uptime` — and **not** `codeServerReady`.
- Cloud's cluster registration never receives the field, so the Firestore cluster doc has `codeServerReady: undefined`.
- ReadyStep gates the button with `cluster?.codeServerReady === true` → false forever → button permanently disabled.
- Schema and plumbing for the field exist top-to-bottom in cloud and web. There's just no producer on the cluster.

### B. The cluster's relay client has no route for `/code-server`

Cloud's IDE proxy forwards through the relay with path `/code-server${subPath}`. The orchestrator constructs the relay client with only one route:

```typescript
routes: [
  { prefix: '/control-plane', target: `unix://${controlPlaneSocket}` },
],
```

No `/code-server → unix:///run/code-server.sock` entry. IDE traffic falls back to the orchestrator's Fastify on `127.0.0.1:3100`, which has no `/code-server/*` handler → 404. (Same shape as the control-plane bug #574.)

### C. Code-server is never started in the cluster

The control-plane has `code-server-manager.ts` and a `code-server-start` lifecycle action. Nothing in the bootstrap flow calls it. Even if A and B were fixed, the unix socket at `/run/code-server.sock` wouldn't exist.

## User Stories

### US1: Developer opens IDE after bootstrap

**As a** developer who just completed the bootstrap wizard,
**I want** the "Open IDE" button to work immediately,
**So that** I can start coding in the cluster's workspace without manual intervention.

**Acceptance Criteria**:
- [ ] After bootstrap completes, the "Open IDE" button is enabled within seconds
- [ ] Clicking "Open IDE" opens the cloud-hosted IDE proxy (not vscode.dev/tunnel)
- [ ] The IDE shows the cluster's `/workspaces/<project>` directory

### US2: Returning user opens IDE on a running cluster

**As a** developer returning to an already-bootstrapped cluster,
**I want** the IDE button to reflect the actual code-server status,
**So that** I know whether the IDE is available before clicking.

**Acceptance Criteria**:
- [ ] `codeServerReady` is included in relay metadata heartbeats
- [ ] The button state tracks live code-server availability

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `bootstrap-complete` lifecycle action triggers `code-server-start` | P1 | Socket must exist before user clicks |
| FR-002 | `initializeRelayBridge` adds `/code-server` route entry pointing to `unix:///run/code-server.sock` | P1 | Same pattern as #574 control-plane route |
| FR-003 | `collectMetadata` includes `codeServerReady: boolean` in relay metadata payload | P1 | Cloud already passes `...metadata` through — no cloud changes needed |
| FR-004 | Code-server socket path configurable via `CODE_SERVER_SOCKET_PATH` env var (default `/run/code-server.sock`) | P2 | Consistency with other socket path conventions |

## Proposed Fix

Three matching changes, all within this repo:

1. **Control-plane lifecycle**: On `bootstrap-complete`, also trigger `code-server-start` so the socket exists before the user clicks anything.
2. **Orchestrator relay routes** (`packages/orchestrator/src/server.ts`): `initializeRelayBridge` adds a second route entry:
   ```typescript
   { prefix: '/code-server', target: `unix://${codeServerSocket}` },
   ```
   where `codeServerSocket` resolves to `process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/code-server.sock'`.
3. **Relay metadata** (`packages/cluster-relay/src/metadata.ts`): `collectMetadata` checks code-server socket existence (or queries the control-plane) and includes `codeServerReady` in the payload. Cloud's `cluster-registration.ts` already passes `...metadata` through, so this lands in Firestore and propagates through SSE without further cloud changes.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Code-server socket exists after bootstrap | Socket present at `/run/code-server.sock` | `docker exec <orchestrator> ls -la /run/code-server.sock` |
| SC-002 | `codeServerReady` in Firestore | `true` after fresh launch | Check Firestore cluster doc |
| SC-003 | "Open IDE" button enabled | Renders enabled on ReadyStep | Visual / E2E test |
| SC-004 | IDE shows cluster workspace | `/workspaces/<project>` visible | Navigate via cloud IDE proxy |

## Assumptions

- Cloud's `cluster-registration.ts` passes `...metadata` through to Firestore without filtering — no cloud-side changes required for `codeServerReady`.
- The `code-server-manager.ts` and `code-server-start` lifecycle action in control-plane are functional and tested.
- The cluster-base image includes code-server installed and ready to be started.

## Out of Scope

- #584 (VS Code Desktop tunnel binds to host) — separate root cause, separate fix
- Cloud-side changes to `cluster-registration.ts` or `use-cluster-status.ts` (not needed per analysis)
- WebSocket tunnel support for code-server (already handled by `tunnel-handler.ts`)
- Code-server configuration (extensions, settings) — orthogonal concern

## Related

- #584 (VS Code Desktop tunnel binds to host — separate but contributes to the Windows-host symptom)
- #574 (control-plane route registration — same architectural pattern, already fixed; replicate for code-server)
- #572 (cluster ↔ cloud contract umbrella)

---

*Generated by speckit*
