# Feature Specification: Resume VS Code tunnel (and code-server) on cluster restart

**Branch**: `824-summary-after-cluster-stopped` | **Date**: 2026-07-07 | **Status**: Draft
**Issue**: [generacy-ai/generacy#824](https://github.com/generacy-ai/generacy/issues/824)
**Type**: Bug fix

## Summary

After a cluster is stopped and started (`generacy stop` → `generacy start`, or any
container restart), the VS Code Desktop tunnel (`code tunnel` → vscode.dev) never
comes back. `generacy stop` explicitly stops the tunnel, but nothing restarts it on
the next boot, so the cloud project page shows the tunnel disconnected and
`https://vscode.dev/tunnel/<name>` stops resolving.

The same restart gap applies to `code-server`, which is started from the same
`bootstrap-complete` handler.

## Root Cause

The VS Code tunnel and code-server are auto-started in exactly **one** place — the
control-plane `bootstrap-complete` lifecycle handler
(`packages/control-plane/src/routes/lifecycle.ts`), which calls
`getVsCodeTunnelManager().start()` and the code-server start path.

The orchestrator only *replays* `bootstrap-complete` at startup when post-activation
is considered incomplete
(`packages/orchestrator/src/services/post-activation-retry.ts`):

```ts
needsRetry = activated && !postActivationComplete
```

`postActivationComplete` is the existence of
`/var/lib/generacy/post-activation-complete` on the persistent `generacy-data`
volume, written once on first successful activation. On every subsequent restart:

- `cluster-api-key` present → `activated = true`
- `post-activation-complete` present → `postActivationComplete = true`
- ⇒ `needsRetry = false` → `bootstrap-complete` is never replayed → the tunnel and
  code-server are never started.

Meanwhile `generacy stop` explicitly stops the tunnel via
`lifecycleAction(ctx, 'vscode-tunnel-stop')`
(`packages/generacy/src/cli/commands/stop/index.ts`). Net: **stop kills the tunnel,
start never revives it.**

Prior art: **#652** fixed the `needsRetry = true` path (failed post-activation).
This issue is the opposite gap — when post-activation *succeeded*, services are
not resumed on restart.

## User Stories

### US1: Cluster user resumes work after stop/start (P1)

**As a** Generacy cluster user who has previously bootstrapped a cluster,
**I want** the VS Code Desktop tunnel and code-server to be automatically running
after I `generacy stop` and `generacy start` (or the orchestrator container is
restarted for any reason),
**So that** I can immediately open my IDE from the cloud project page or
`https://vscode.dev/tunnel/<name>` without manually triggering a restart from the
UI.

**Acceptance Criteria**:
- [ ] After a cluster is bootstrapped and connected, stopping the cluster and
  starting it again results in the VS Code tunnel being reachable at
  `https://vscode.dev/tunnel/<name>` within the metadata-refresh window (seconds,
  not minutes).
- [ ] After the same stop/start cycle, code-server is reachable through the cloud
  IDE proxy (the `codeServerReady` metadata field flips true).
- [ ] The resume path is idempotent: if the tunnel or code-server is already
  running, orchestrator boot does not spawn a duplicate or error out.
- [ ] Fresh (never-activated) clusters are unaffected — the existing wizard flow
  still owns first-boot startup.
- [ ] Clusters that have activated but never completed post-activation (the
  `needsRetry = true` path from #652) still trigger the full `bootstrap-complete`
  replay — the new path only handles the "already succeeded" gap.

### US2: Operator observes deterministic tunnel state (P2)

**As an** operator debugging a cluster,
**I want** the tunnel-resume behavior to emit the same relay events (`starting`,
`connected`) that the first-boot start emits,
**So that** the cloud project page's cluster status accurately reflects tunnel
state after a restart without any special-case handling.

**Acceptance Criteria**:
- [ ] Tunnel state transitions on restart drive the same `cluster.vscode-tunnel`
  relay events as first-boot start.
- [ ] Orchestrator startup logs a single structured event indicating whether the
  boot-time resume path fired and what it invoked.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                          | Priority | Notes                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| FR-001 | Orchestrator startup MUST, when the cluster is `activated` AND `postActivationComplete` is true, ensure the VS Code tunnel is running.                                                               | P1       | The gap #652 did not cover. Existing `needsRetry` path is untouched.                             |
| FR-002 | Orchestrator startup MUST, under the same conditions, ensure code-server is running.                                                                                                                 | P1       | Same handler restarted the same pair on first boot; keep them together.                          |
| FR-003 | The resume action MUST be safe to invoke when the target service is already running (idempotent no-op).                                                                                              | P1       | `VsCodeTunnelProcessManager.start()` and the code-server manager already have idempotent guards. |
| FR-004 | The resume action MUST NOT re-run any other `bootstrap-complete` side effects (workspace clone, credential seeding, sentinel writes).                                                                | P1       | Those are already gated by their own sentinels; a full replay risks re-doing one-shot work.      |
| FR-005 | The resume action MUST NOT run on unactivated clusters (`cluster-api-key` absent).                                                                                                                   | P1       | First boot still goes through activation → wizard → `bootstrap-complete`.                        |
| FR-006 | Tunnel/code-server state changes triggered by resume MUST emit the same relay events as first-boot start (`cluster.vscode-tunnel`, `codeServerReady` metadata).                                      | P2       | Cloud dashboard doesn't need to know a resume happened vs. a first-boot start.                   |
| FR-007 | Failure of the tunnel resume MUST NOT block orchestrator boot or crash the process; it MUST be logged and surfaced (e.g., via a relay event) so the failure is observable.                           | P2       | Boot must remain resilient (matches existing patterns in `code-server-probe`, activation retry). |
| FR-008 | If the resume path is implemented on the orchestrator side (calling control-plane), it MUST use the same lifecycle route (`POST /lifecycle/vscode-tunnel-start`, `POST /lifecycle/code-server-start`) already used by the CLI and control-plane. | P1       | Avoid a second start path — one code path, one set of side effects.                              |

## Success Criteria

| ID     | Metric                                                                                                                              | Target                                                                                              | Measurement                                                                              |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SC-001 | Time from `generacy start` returning to VS Code tunnel being reachable at `https://vscode.dev/tunnel/<name>` on a previously-bootstrapped cluster. | < 60 s in steady state; metadata refresh window drives most of that.                                | Manual repro: bootstrap → stop → start → curl vscode.dev tunnel URL / poll cluster metadata. |
| SC-002 | Percentage of stop/start cycles on activated clusters that leave the tunnel disconnected.                                           | 0% (down from 100% today).                                                                          | Manual repro on `sniplink`-style cluster; check for `code tunnel` PID and relay state.   |
| SC-003 | Percentage of stop/start cycles on activated clusters that leave code-server unreachable.                                           | 0%.                                                                                                 | Cloud IDE proxy reports `codeServerReady: true` within metadata refresh window.          |
| SC-004 | Number of duplicate `code tunnel` or `code-server` processes started when both the resume path and an already-running service exist. | 0 duplicates.                                                                                       | Inspect orchestrator container processes after triggering resume with services already running. |
| SC-005 | Regressions in the existing `needsRetry` path (first-boot recovery from failed post-activation, per #652).                          | 0 — existing behavior unchanged.                                                                    | Manual repro of a cluster where post-activation was interrupted; confirm bootstrap-complete replays. |

## Assumptions

- `VsCodeTunnelProcessManager.start()` and the code-server manager are already
  idempotent — as claimed in the issue and confirmed by the manual repro that
  showed `POST /lifecycle/vscode-tunnel-start` connecting immediately using
  persisted state.
- The persisted VS Code CLI state (`~/.vscode/cli/code_tunnel.json`, tokens under
  `/home/node/.vscode/cli`) is preserved across container restarts by the existing
  named volume, so tunnel resume does not require re-authentication.
- Restart does not require re-issuing device codes; a valid persisted CLI token
  survives the stop/start cycle.
- The control-plane socket (`/run/generacy-control-plane/control.sock`) is
  reachable from the orchestrator by the time the boot-time resume step runs (or
  the resume step waits for it, mirroring the existing control-plane probe
  pattern).
- No cross-repo changes are needed. `cluster-base` entrypoints already run the
  orchestrator and control-plane processes; only the resume logic changes.

## Out of Scope

- Restart button UI/UX changes (the "device-code timeout orphans tunnel child"
  companion bug is filed separately).
- Any change to the first-boot bootstrap flow, wizard, or post-activation
  entrypoint script.
- Changes to how the tunnel name is derived (#608) or how tunnel auth is
  persisted.
- Restart of unrelated services (credhelper-daemon, monitors) — those already
  survive restart via their own entrypoints.
- Making `generacy stop` skip the tunnel stop (the fix is to resume on start, not
  to change stop behavior).
- Cross-repo (`cluster-base`, `generacy-cloud`) changes.

## Design Options (for planning phase)

The issue proposes two non-exclusive options; the plan phase will pick one (or
both):

1. **Orchestrator-side boot resume**: at orchestrator startup, when `activated`
   is true, POST `/lifecycle/vscode-tunnel-start` and `/lifecycle/code-server-start`
   to the control-plane socket. Purely additive — no `bootstrap-complete` semantics
   involved, no sentinel handling changes.
2. **Control-plane self-start on boot**: when control-plane starts and detects
   persisted VS Code CLI registration and a running/reachable orchestrator,
   auto-start the tunnel and code-server itself.

Option 1 is the smaller, more targeted change and stays within the existing
`activated`-gated resume patterns. Option 2 changes control-plane boot semantics
and may need extra guarding to avoid double-start with the orchestrator path.

---

*Generated by speckit*
