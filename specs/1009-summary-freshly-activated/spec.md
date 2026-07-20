# Feature Specification: VS Code Desktop tunnel auth lost on new clusters — post-activation self-restart races the device-code flow

**Branch**: `1009-summary-freshly-activated` | **Date**: 2026-07-20 | **Status**: Draft | **Type**: Bug fix

## Summary

On a **freshly activated wizard cluster**, the "Connect with VS Code Desktop" tunnel flow is offered to the user *before* the post-activation self-restart of the orchestrator has happened. If the user starts the tunnel and completes the GitHub device-code auth inside that window, the post-activation hook restarts the orchestrator container out from under the running `code tunnel` process — killing it before the auth token is persisted. The user's successful authorization is silently lost, and every subsequent attempt shows a fresh device code, leading to confusion and an eventual **"Timed out waiting for device-code authorization"** in the modal.

This has now happened to at least two users/clusters. The manual recovery is non-obvious (re-run the device login server-side and re-auth once the cluster is stable), so it warrants a real fix.

## Impact

- First-time tunnel connect on a new cluster frequently fails for no user-visible reason.
- The failure mode *looks* like the user was "too slow" or the device flow is broken, but the real cause is a container restart racing the auth.
- Users burn multiple GitHub device codes and hit the 5-minute auth timeout.

## Root Cause

Two facts combine to create the race:

1. **Post-activation self-restart.** `entrypoint-post-activation.sh` restarts the workers and then **self-restarts the orchestrator container** to re-resolve repos/identity and enable the label monitor (`restart_cluster_containers()` → `docker restart "$self_container"` in `cluster-microservices/.devcontainer/generacy/scripts/entrypoint-post-activation.sh` ~L255; same in `cluster-base`). This runs ~30–60s **after** the cluster has already reported `Active`/`Connected` to the cloud and the UI has enabled the tunnel button.

2. **Tunnel availability is not gated on the restart completing.** The VS Code tunnel (`code tunnel`, spawned by `vscode-tunnel-manager.ts` in `control-plane`, auto-started on `bootstrap-complete` in `control-plane/src/routes/lifecycle.ts` and startable on demand from the UI) can be launched during that pre-restart window. The auth token is only written to the persistent `vscode-cli-state` volume *after* the device flow completes; a `docker restart` SIGTERM/SIGKILL landing mid-auth kills `code tunnel` before `token.json` is written, so nothing persists.

**Net:** the cluster advertises "tunnel-ready" during a window in which starting the tunnel is guaranteed to be destroyed by a pending self-restart.

### Evidence (cluster `snappoll`, project `zN1zb5rIreyV4vHMUjJJ`)

Orchestrator container `snappoll-orchestrator-1`, `GENERACY_CLUSTER_ID=e227b79d-e79b-4bca-b2…`, tunnel name `g-e227b79de79b4bcab2`.

```
15:52:41  Cluster activated successfully
15:52:48  [post-activation] Starting post-activation setup...
15:53:18  [post-activation] Marked post-activation complete
15:53:18  [post-activation] Restarting worker containers: ...
15:53:25  {"msg":"Received SIGTERM, initiating graceful shutdown"}   <-- orchestrator self-restart
15:53:26  [orchestrator] Starting orchestrator setup...              <-- fresh container
```

The user completed the GitHub device auth in an attempt that overlapped 15:53. Afterward, the tunnel's persistent volume (`snappoll_vscode-cli-state` → `/home/node/.vscode/cli`) contained only a stale `tunnel-stable.lock` and **no `token.json`** — the auth never persisted. The next attempt drew a fresh device code and hit the 5-minute `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` (`vscode-tunnel-manager.ts:45`, `armAuthTimer` → "Timed out waiting for device-code authorization" at L477).

Manual recovery: with the cluster now stable, run `code tunnel user login --provider github --cli-data-dir /home/node/.vscode/cli` inside the orchestrator, authorize once → `token.json` persists → the manager's `code tunnel` process reaches `connected` with no further prompt.

## User Stories

### US1: First-time user connects VS Code Desktop after cluster activation (primary)

**As a** user who just activated a new Generacy cluster via the wizard,
**I want** the "Connect with VS Code Desktop" tunnel flow to only be offered after the cluster has finished its one-shot post-activation self-restart,
**So that** my GitHub device-code authorization is never destroyed mid-flow by a container restart, and my first tunnel connect succeeds without silent failure.

**Acceptance Criteria**:
- [ ] The tunnel button is disabled/hidden (or the auto-start on `bootstrap-complete` is deferred) while the post-activation self-restart is still pending.
- [ ] Once the `post-activation-restart-done` marker is present, the tunnel becomes available and the auth flow, when completed by the user, produces a persistent `token.json` in the `vscode-cli-state` volume.
- [ ] No user-visible loss of state or timeout occurs on the first tunnel-connect attempt on a freshly activated cluster.

### US2: Recovery when a tunnel attempt was made pre-restart

**As a** user who tried to connect VS Code Desktop before the cluster settled,
**I want** the UI to recover cleanly once the cluster is stable (either by re-prompting for auth or by reflecting that no auth exists yet),
**So that** I don't sit staring at a device code that will never complete and time out at 5 minutes.

**Acceptance Criteria**:
- [ ] After the post-restart re-run, if a tunnel connect was requested pre-restart, tunnel state is re-emitted so the UI re-prompts cleanly instead of silently timing out.
- [ ] The user never has to know about the restart machinery to recover.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Cluster readiness signalling MUST include a "post-activation settled" bit derived from the existing `/var/lib/generacy/post-activation-restart-done` marker file. | P1 | Marker survives the self-restart. |
| FR-002 | The `bootstrap-complete` lifecycle action MUST NOT auto-start the VS Code tunnel if the post-activation self-restart has not yet completed. | P1 | Fires in `control-plane/src/routes/lifecycle.ts`. |
| FR-003 | The cloud/UI "Connect with VS Code Desktop" affordance MUST be gated (disabled or hidden) until the post-activation-settled signal is true. | P1 | Cloud-side companion change; contract owned here. |
| FR-004 | When the post-activation self-restart completes, cluster readiness MUST propagate to the cloud within the existing metadata heartbeat window (seconds, not the 60s heartbeat). | P1 | Follow #586's `codeServerReady` propagation pattern. |
| FR-005 | If a tunnel-start was requested during the pre-settled window (e.g. by an older UI or by a race), the tunnel manager MUST NOT attempt device-code auth until settled; on settle it MAY re-emit `starting` so the UI re-prompts. | P2 | Prevents silent timeouts. |
| FR-006 | The post-activation-settled signal MUST be idempotent and MUST remain true across subsequent orchestrator restarts (stop/start, boot-resume). | P1 | The marker file already survives; formalize the invariant. |
| FR-007 | On clusters that have already completed post-activation before this change ships, the settled signal MUST evaluate true immediately (no manual migration). | P1 | Backward compatibility for existing clusters. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | First-attempt tunnel-connect success rate on freshly activated wizard clusters. | ≥ 95% (up from the current failure-prone rate observed in at least two clusters). | Track `code tunnel` device-flow outcomes on the first activation of a cluster; count "connected" vs "device-code timeout" vs "SIGTERM during auth" over a rolling window. |
| SC-002 | No orchestrator SIGTERM during an in-flight `code tunnel` device-code auth on newly activated clusters. | 0 occurrences in production over 30 days post-fix. | Correlate `Received SIGTERM` orchestrator log lines against active `armAuthTimer` windows in `vscode-tunnel-manager.ts`. |
| SC-003 | Time-to-first-tunnel-ready (from cluster `Active/Connected` in the UI to tunnel button enabled). | Bounded by post-activation-settled marker propagation; MUST be observable to the user as a short "finalizing…" state, not a silent trap. | UI telemetry / QA screenshots on wizard first-run. |
| SC-004 | Bug does not regress. | Zero reopens of #1009 or new duplicates filed with the same symptom ("device code timed out, tunnel volume missing token.json") for 60 days post-fix. | Issue tracker sweep. |

## Assumptions

- The `post-activation-restart-done` marker file at `/var/lib/generacy/post-activation-restart-done` already exists and is written by `entrypoint-post-activation.sh` after the self-restart completes.
- The cloud/UI is willing to consume a new readiness bit alongside existing metadata fields (`codeServerReady`, `controlPlaneReady` — same shape as #586, #624).
- Post-activation self-restart is a one-shot event per cluster lifetime; it does not repeat on subsequent stop/start cycles.
- The `vscode-cli-state` docker volume is the correct persistence surface for `token.json` and is bound into the orchestrator container.
- Users interact with the tunnel flow through the cloud UI, not by directly hitting the control-plane `lifecycle` endpoint.

## Out of Scope

- Fixing #966 (tunnel hangs on "Starting tunnel…", device-code event dropped) — that is a distinct failure mode where the event pipeline is broken, not where the auth is destroyed.
- Restructuring `entrypoint-post-activation.sh` to avoid the self-restart entirely. The self-restart is intentional (re-resolves repos/identity, enables label monitor) and out of scope; this spec gates *around* it.
- Changes to `code tunnel`'s own auth persistence semantics.
- Cloud-side UI copy / "finalizing…" state design — a companion cloud issue owns the visual affordance; this spec owns the readiness signal contract.
- Retroactive recovery of already-lost tunnel auth on clusters that were affected before the fix ships. Manual recovery path (documented in root-cause section) remains.

## Related Work

- #824 — VS Code tunnel never restarts after stop/start (bootstrap-complete gated behind `needsRetry`/post-activation-complete). Same restart-vs-tunnel interaction, different symptom.
- #834 — boot-resume from #824 never fires on wizard-provisioned clusters.
- #937 — post-activation retry replays bootstrap-complete before `GH_TOKEN` sealed (same self-restart machinery).
- #966 — tunnel hangs on "Starting tunnel…", device-code event dropped.

This issue is distinct from #966: the auth **succeeds** but is destroyed by the post-activation self-restart because tunnel availability isn't gated on that restart completing.

---

*Generated by speckit*
