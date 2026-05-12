# Feature Specification: VS Code Desktop tunnel — cluster-owned tunnel with device-code auth

**Branch**: `584-symptoms-after-completing` | **Issue**: #584 | **Date**: 2026-05-12 | **Status**: Draft

## Summary

VS Code Desktop tunnel connections land on the user's local machine instead of the cluster's orchestrator container. Two compounding bugs: (1) the `code` CLI (Microsoft's tunnel binary) is not installed in cluster-base — only `code-server` (browser IDE) is present, and (2) the dialog UX asks users to copy-paste a CLI command into "a terminal", which they run on their host machine instead of inside the cluster.

The fix replaces the manual copy-paste flow with a cluster-owned tunnel: the cluster starts `code tunnel` itself, surfaces a GitHub device code to the web UI, and the user authenticates via `github.com/login/device`. This mirrors the existing v1.5 cluster activation device-code pattern.

## Root Cause

### 1. Missing `code` CLI in cluster-base

The Dockerfile installs `code-server` (open-source browser IDE) but not Microsoft's `code` CLI, which provides the `code tunnel` subcommand. These are distinct binaries. Running `code tunnel ...` inside the cluster fails with `command not found`.

### 2. Fragile copy-paste UX

`VSCodeDesktopDialog.tsx` shows `code tunnel --accept-server-license-terms --name ${clusterId}` with a copy button. Users paste this into their local terminal, binding the tunnel to their host machine. The deep link then opens VS Code attached to the wrong host.

## User Stories

### US1: Developer connects VS Code Desktop to cluster

**As a** developer using Generacy,
**I want** VS Code Desktop to connect directly to my cluster's orchestrator container,
**So that** I can edit code, run commands, and use extensions in the cluster environment without manual CLI setup.

**Acceptance Criteria**:
- [ ] Clicking "VS Code Desktop" in the web UI initiates a device-code flow (no CLI copy-paste)
- [ ] The web UI displays a GitHub device code and a link to `github.com/login/device`
- [ ] After authenticating, the `vscode://` deep link opens VS Code Desktop attached to the cluster container
- [ ] Terminal inside VS Code lands in `/workspaces/<project>` as the `node` user

### US2: Tunnel persists across cluster lifecycle

**As a** developer,
**I want** the VS Code tunnel to survive cluster restarts,
**So that** I don't have to re-authenticate every time the cluster reboots.

**Acceptance Criteria**:
- [ ] Tunnel auto-starts on cluster boot (or re-binds on restart)
- [ ] No re-authentication required after a cluster restart if the GitHub token is still valid

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Install Microsoft `code` CLI in cluster-base image (`/usr/local/bin/code`) | P1 | Standalone tarball from `update.code.visualstudio.com/latest/cli-linux-x64/stable` |
| FR-002 | Add `vscode-tunnel-start` lifecycle action in control-plane | P1 | Spawns `code tunnel` with `--name <clusterId>`, parses device code from stdout |
| FR-003 | Surface device code to web UI via relay event channel | P1 | Use `cluster.vscode-tunnel` relay channel (or similar) |
| FR-004 | Web UI displays device code and `github.com/login/device` link | P1 | Replace current copy-paste CLI dialog |
| FR-005 | Remove manual CLI copy-paste block from `VSCodeDesktopDialog.tsx` | P1 | generacy-cloud repo |
| FR-006 | Tunnel auto-starts on cluster boot or lifecycle trigger | P2 | `code tunnel service install` or supervisor integration |
| FR-007 | Add `vscode-tunnel-stop` lifecycle action | P2 | Clean shutdown of tunnel process |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `code --version` in orchestrator container | Returns valid version | `docker exec <orchestrator> code --version` |
| SC-002 | Web UI shows device code (not CLI string) | 100% of bootstrap completions | Manual QA / E2E test |
| SC-003 | VS Code Desktop deep link lands in cluster | Terminal at `/workspaces/<project>`, `node` user | Manual QA |
| SC-004 | Tunnel survives cluster restart | Re-binds without re-auth | Restart cluster, verify tunnel reconnects |

## Assumptions

- Microsoft's standalone `code` CLI tarball is redistributable within Docker images (MIT-licensed CLI component)
- The `code tunnel` command's stdout device-code output format is stable and parseable
- GitHub device-code auth tokens persist across process restarts when using `code tunnel service install`
- The relay event channel pattern (used by audit, credentials, bootstrap) is suitable for surfacing tunnel state

## Out of Scope

- Browser-based VS Code (code-server) — already working via tunnel-handler over relay
- Multi-user tunnel support (one tunnel per cluster is sufficient for v1)
- Tunnel authentication via means other than GitHub device code
- Windows/macOS cluster-base variants (Linux x64 only)

## Cross-Repo Scope

This feature spans three repositories:
1. **cluster-base** — Dockerfile change to install `code` CLI
2. **generacy** (this repo) — control-plane lifecycle action, relay event wiring
3. **generacy-cloud** — Web UI dialog replacement, device-code display

---

*Generated by speckit*
