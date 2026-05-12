# Feature Specification: ## Symptoms

After completing bootstrap, clicking "VS Code Desktop" → following the dialog instructions to run \`code tunnel --accept-server-license-terms --name <clusterId>\` → authenticating via GitHub device code → connecting from VS Code Desktop lands you on the user's local machine (Windows host in my case), NOT inside the cluster's orchestrator container

**Branch**: `584-symptoms-after-completing` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

## Symptoms

After completing bootstrap, clicking "VS Code Desktop" → following the dialog instructions to run \`code tunnel --accept-server-license-terms --name <clusterId>\` → authenticating via GitHub device code → connecting from VS Code Desktop lands you on the user's local machine (Windows host in my case), NOT inside the cluster's orchestrator container. Same observation in a browser tunnel session.

## Root cause (two compounding bugs)

### 1. The \`code\` CLI is not installed in cluster-base

[\`.devcontainer/generacy/Dockerfile\`](https://github.com/generacy-ai/cluster-base/blob/develop/.devcontainer/generacy/Dockerfile#L36-L46) installs \`code-server\` (the open-source browser IDE), but never installs Microsoft's proprietary \`code\` CLI. The two are distinct:
- \`code-server\` = browser IDE, listens on a socket. Pre-installed. Served via the control-plane's [\`tunnel-handler\`](packages/control-plane/src/services/tunnel-handler.ts) over the relay.
- \`code\` = Microsoft's CLI for the \`code tunnel\` subcommand. **Not** installed.

So running \`code tunnel ...\` inside the browser IDE's terminal would fail with \`command not found\` — the dialog's instructions cannot actually be followed.

### 2. The dialog's UX hands the user a CLI string and assumes they paste it in the right terminal

[\`VSCodeDesktopDialog.tsx:28\`](https://github.com/generacy-ai/generacy-cloud/blob/main/packages/web/src/components/clusters/VSCodeDesktopDialog.tsx#L28) shows \`code tunnel --accept-server-license-terms --name \${clusterId}\` with a copy button. Users with VS Code Desktop already installed locally will paste this into whatever terminal they have open — including their host shell. The resulting tunnel binds to their host machine, so the subsequent deep link \`vscode://vscode-remote/tunnel+\${clusterId}/\` opens a remote session attached to the wrong host.

This is what happened in my run. Even ignoring bug #1, the UX is structurally fragile.

## Proposed fix

The cluster should own its own \`code tunnel\`. The flow should be:

1. **cluster-base:** add the \`code\` CLI to the image. Microsoft publishes it as part of the [VS Code CLI distribution](https://code.visualstudio.com/docs/remote/tunnels#_using-the-code-cli) — a standalone tarball at \`https://update.code.visualstudio.com/latest/cli-linux-x64/stable\`. Drop into \`/usr/local/bin/code\`.
2. **control-plane:** add a \`vscode-tunnel-start\` lifecycle action that spawns \`code tunnel service install --accept-server-license-terms --name <clusterId>\` (or just \`code tunnel --name <clusterId>\` as a daemon) inside the orchestrator container. Parse the device code from stdout and surface it.
3. **web bootstrap step** (or a separate post-bootstrap step): show the device code from the cluster (analogous to the existing v1.5 cluster activation device-code flow), tell the user to go to \`github.com/login/device\` and enter that code. After auth, the tunnel is bound to the user's GitHub account but **runs on the cluster**, so the \`vscode://vscode-remote/tunnel+<clusterId>/\` deep link lands in the cluster.
4. **VSCodeDesktopDialog:** remove the copy-paste CLI block entirely. Either auto-show the device code or skip the dialog when the tunnel is already running.

This mirrors the v1.5 cluster activation pattern exactly: cluster initiates, surfaces device code to web, user authenticates, cluster proceeds.

## Test plan
- [ ] After cluster-base rebuild: \`docker exec <orchestrator> code --version\` returns a version
- [ ] Bootstrap completes, web UI surfaces a device code from the cluster (not a CLI string)
- [ ] After GitHub auth, \`vscode://vscode-remote/tunnel+<clusterId>/\` opens VS Code Desktop attached to the orchestrator container — terminal lands in \`/workspaces/<project>\`, the workspace mounts are visible, \`node\` user, etc.
- [ ] Tunnel persists across cluster restarts (or re-binds on restart)

## Related
- #572 (cluster ↔ cloud contract umbrella)
- Cluster-base image install of \`code\` may want its own cluster-base-side issue once this is scoped

## Scope

This issue covers **generacy repo only**: control-plane lifecycle actions, relay events, auto-start logic, and scaffolder volume addition. Companion issues needed for:
- **cluster-base**: Dockerfile `code` CLI install (FR-001)
- **generacy-cloud**: UI removes copy-paste dialog, replaces with device-code display + relay event listener (FR-004/FR-005)

## User Stories

### US1: VS Code Desktop Connection via Cluster-Owned Tunnel

**As a** developer completing bootstrap,
**I want** the cluster to automatically start a VS Code tunnel and surface the GitHub device code in the web UI,
**So that** I can authenticate once and connect VS Code Desktop directly to the cluster without running commands locally.

**Acceptance Criteria**:
- [ ] `vscode-tunnel-start` lifecycle action spawns `code tunnel` inside the orchestrator container
- [ ] Device code and verification URI are surfaced to the web UI via `cluster.vscode-tunnel` relay events
- [ ] After GitHub auth, `vscode://vscode-remote/tunnel+<clusterId>/` opens VS Code Desktop attached to the orchestrator container
- [ ] No CLI string is presented to the user for local execution

### US2: Tunnel Persistence Across Cluster Restarts

**As a** developer,
**I want** the VS Code tunnel to survive cluster restarts and container recreation,
**So that** I don't need to re-authenticate with GitHub after running `generacy update`.

**Acceptance Criteria**:
- [ ] `~/.vscode-cli/` is persisted via a named Docker volume (`vscode-cli`)
- [ ] Tunnel auth survives both `docker restart` and `docker compose down && up`
- [ ] Volume is private to the orchestrator container (not shared with workers)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-002 | `vscode-tunnel-start` lifecycle action in control-plane | P1 | Spawns `code tunnel --accept-server-license-terms --name <clusterId>` |
| FR-003 | Relay events on `cluster.vscode-tunnel` channel | P1 | Full lifecycle: `starting`, `authorization_pending`, `connected`, `disconnected`, `error` |
| FR-006 | Auto-start tunnel on bootstrap-complete or container start | P2 | Follow `CodeServerProcessManager` pattern (managed child process) |
| FR-007 | `vscode-tunnel-stop` lifecycle action | P2 | Stops the tunnel process |
| FR-008 | `vscode-cli` named volume in scaffolder | P1 | Persists `~/.vscode-cli/` across container recreation |

## Relay Event Schema

Channel: `cluster.vscode-tunnel`

```typescript
{
  status: 'starting' | 'authorization_pending' | 'connected' | 'disconnected' | 'error';
  deviceCode?: string;        // present when status === 'authorization_pending'
  verificationUri?: string;   // present when status === 'authorization_pending'
  tunnelName?: string;        // present when status === 'connected'
  error?: string;             // present when status === 'error'
  details?: string;           // raw stdout on parse failure
}
```

## Device Code Parsing Strategy

- Regex parsing of `code tunnel` stdout (no `--output json` available)
- Line-by-line scan for `/^([A-Z0-9]{4}-[A-Z0-9]{4})/` and `https://github.com/login/device`
- On match: emit `authorization_pending` event with `deviceCode` and `verificationUri`
- On 30s timeout without match: emit `error` event with raw last-20-lines as `details`
- Fallback ensures user can still complete activation manually even if format changes

## Process Management

- Follow existing `CodeServerProcessManager` pattern (managed child process with start/stop lifecycle actions)
- No systemd dependency (container doesn't run systemd as PID 1)
- No supervisor needed (overkill for single process)

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Tunnel lifecycle actions | Both `vscode-tunnel-start` and `vscode-tunnel-stop` work | Integration test |
| SC-002 | Relay events emitted | All 5 status states emit correctly | Unit test |
| SC-003 | Auth persistence | Tunnel reconnects without re-auth after `docker compose down && up` | Manual test |

## Assumptions

- The `code` CLI will be installed in cluster-base via a companion issue
- `code tunnel` stdout format is stable enough for regex parsing (version-pinned in cluster-base)
- The relay event infrastructure (`setRelayPushEvent`) works the same as `cluster.bootstrap` channel

## Out of Scope

- FR-001: `code` CLI installation in cluster-base Dockerfile (companion issue)
- FR-004: Web UI device code display (generacy-cloud companion issue)
- FR-005: VSCodeDesktopDialog removal/replacement (generacy-cloud companion issue)
- Idle timeout for tunnel process (defer to follow-up)
- Multi-user tunnel support

---

*Generated by speckit*
