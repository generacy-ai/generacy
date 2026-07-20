# Feature Specification: ## Summary

On a **freshly activated wizard cluster**, the "Connect with VS Code Desktop" tunnel flow is offered to the user *before* the post-activation self-restart of the orchestrator has happened

**Branch**: `1009-summary-freshly-activated` | **Date**: 2026-07-20 | **Status**: Draft

## Summary

## Summary

On a **freshly activated wizard cluster**, the "Connect with VS Code Desktop" tunnel flow is offered to the user *before* the post-activation self-restart of the orchestrator has happened. If the user starts the tunnel and completes the GitHub device-code auth inside that window, the post-activation hook restarts the orchestrator container out from under the running `code tunnel` process — killing it before the auth token is persisted. The user's successful authorization is silently lost, and every subsequent attempt shows a fresh device code, leading to confusion and an eventual **"Timed out waiting for device-code authorization"** in the modal.

This has now happened to at least two users/clusters. The manual recovery is non-obvious (re-run the device login server-side and re-auth once the cluster is stable), so it warrants a real fix.

## Impact

- First-time tunnel connect on a new cluster frequently fails for no user-visible reason.
- The failure mode *looks* like the user was "too slow" or the device flow is broken, but the real cause is a container restart racing the auth.
- Users burn multiple GitHub device codes and hit the 5-minute auth timeout.

## Root cause

Two facts combine:

1. **Post-activation self-restart.** `entrypoint-post-activation.sh` restarts the workers and then **self-restarts the orchestrator container** to re-resolve repos/identity and enable the label monitor:
   - `restart_cluster_containers()` → `docker restart "$self_container"` (`cluster-microservices/.devcontainer/generacy/scripts/entrypoint-post-activation.sh`, ~L255; same in `cluster-base`).
   - This runs ~30–60s **after** the cluster has already reported `Active`/`Connected` to the cloud and the UI has enabled the tunnel button.

2. **Tunnel availability is not gated on the restart completing.** The VS Code tunnel (`code tunnel`, spawned by `vscode-tunnel-manager.ts` in `control-plane`, auto-started on `bootstrap-complete` in `control-plane/src/routes/lifecycle.ts` and startable on demand from the UI) can be launched during that pre-restart window. The auth token is only written to the persistent `vscode-cli-state` volume *after* the device flow completes; a `docker restart` SIGTERM/SIGKILL landing mid-auth kills `code tunnel` before `token.json` is written, so nothing persists.

Net: the cluster advertises "tunnel-ready" during a window in which starting the tunnel is guaranteed to be destroyed by a pending self-restart.

## Evidence (this occurrence — cluster `snappoll`, project `zN1zb5rIreyV4vHMUjJJ`)

Orchestrator container `snappoll-orchestrator-1`, `GENERACY_CLUSTER_ID=e227b79d-e79b-4bca-b2…`, tunnel name `g-e227b79de79b4bcab2`.

Timeline from `post-activation.log` + orchestrator logs:
```
15:52:41  Cluster activated successfully
15:52:48  [post-activation] Starting post-activation setup...
15:53:18  [post-activation] Marked post-activation complete
15:53:18  [post-activation] Restarting worker containers: ...
15:53:25  {"msg":"Received SIGTERM, initiating graceful shutdown"}   <-- orchestrator self-restart
15:53:26  [orchestrator] Starting orchestrator setup...              <-- fresh container
```
The user completed the GitHub device auth in an attempt that overlapped 15:53. Afterward, the tunnel's persistent volume (`snappoll_vscode-cli-state` → `/home/node/.vscode/cli`) contained only a stale `tunnel-stable.lock` and **no `token.json`** — the auth never persisted. The next attempt drew a fresh device code and hit the 5-minute `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` (`vscode-tunnel-manager.ts:45`, `armAuthTimer` → "Timed out waiting for device-code authorization" at L477).

Manual recovery that worked: with the cluster now stable, run `code tunnel user login --provider github --cli-data-dir /home/node/.vscode/cli` inside the orchestrator, authorize once → `token.json` persists → the manager's `code tunnel` process reaches `connected` with no further prompt.

## Proposed fix

Gate tunnel availability on the post-activation restart being finished, so the flow is never offered during the destructive window:

1. **Preferred:** Expose a "post-activation settled" readiness signal (the `post-activation-restart-done` marker already exists and survives the restart — `entrypoint-post-activation.sh` `RESTART_DONE_MARKER=/var/lib/generacy/post-activation-restart-done`). Have the cloud/UI gate the "Connect with VS Code Desktop" button — and the `bootstrap-complete` auto-start in `lifecycle.ts` — on this signal, so the tunnel can't be started until the one-shot self-restart has occurred.
2. **Alternatively / additionally:** After the post-restart re-run, if a tunnel connect was requested pre-restart, re-emit tunnel state so the UI re-prompts cleanly instead of silently timing out.

Option 1 is the clean prevention: don't advertise tunnel-ready until the cluster has actually stopped restarting.

## Related (all closed)

- #824 — VS Code tunnel never restarts after stop/start (bootstrap-complete gated behind `needsRetry`/post-activation-complete). Same restart-vs-tunnel interaction, different symptom.
- #834 — boot-resume from #824 never fires on wizard-provisioned clusters.
- #937 — post-activation retry replays bootstrap-complete before GH_TOKEN sealed (same self-restart machinery).
- #966 — tunnel hangs on "Starting tunnel…", device-code event dropped.

This one is distinct: the auth **succeeds** but is destroyed by the post-activation self-restart because tunnel availability isn't gated on that restart completing.


## User Stories

### US1: First-time tunnel connect on a fresh wizard cluster

**As a** user provisioning a new Generacy cluster via the cloud wizard,
**I want** the "Connect with VS Code Desktop" button to appear only after the cluster has fully finished its post-activation self-restart,
**So that** my one GitHub device-code authorization actually persists and I don't burn multiple codes to a silent "timed out" failure.

**Acceptance Criteria**:
- [ ] On a freshly activated wizard cluster, the tunnel button is disabled (or hidden) until the cloud sees `postActivationReady === true` from the cluster.
- [ ] Once the post-activation self-restart has finished, the tunnel button re-enables within seconds (not the 60s heartbeat window), driven by the same immediate-push path used for `codeServerReady`.
- [ ] If a user (or the `bootstrap-complete` auto-start) does trigger a `vscode-tunnel-start` while `postActivationReady === false`, the control-plane skips the start with a clear response and no watcher — no device-code auth is initiated in the pre-restart window.
- [ ] After the self-restart, the fresh orchestrator's existing `BootResumeService` dispatches `vscode-tunnel-start` automatically, and the retained `authorization_pending` event replays the device code to the modal so recovery is largely automatic.
- [ ] On a local / non-cloud-activated cluster (no `activated` state), the readiness bit is `true` immediately so the tunnel is not permanently ungated.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The orchestrator MUST expose a `postActivationReady: boolean` field on both the `/health` response and on `ClusterMetadataPayload` sent to the cloud via the relay. | P1 | Q3 — parallel construction with `codeServerReady`, `controlPlaneReady`. |
| FR-002 | `postActivationReady` MUST be computed as `(NOT activated) OR (post-activation-restart-done marker present)`, where `activated` mirrors `PostActivationRetryService.checkPostActivationState()`'s `existsSync(keyFilePath)` and the marker path is `/var/lib/generacy/post-activation-restart-done`. | P1 | Q1 + Batch 2 correction. Do NOT use `post-activation-complete absent` as the fallback — it evaluates true precisely when the gate is most needed. |
| FR-003 | When `postActivationReady` transitions from `false` to `true`, the orchestrator MUST push updated metadata immediately via `sendMetadata()` (do not wait for the 60s heartbeat). A one-shot `fs.watch` on the marker path SHOULD be installed at boot only when the marker is not yet present. | P1 | Q2 — full mirror of #586/#596 `codeServerReady` pattern. |
| FR-004 | The `POST /lifecycle/bootstrap-complete` handler MUST continue to fire wizard-credentials unseal (step a), the `POST_ACTIVATION_TRIGGER` sentinel write (step b), and `codeServerManager.start()` (step c) unconditionally. It MUST skip `tunnelManager.start()` (step d) with a log line when `postActivationReady === false`. No in-process watcher is installed. | P1 | Q6/D. Steps (a)(b) MUST NOT be gated — they are what causes the marker to eventually exist; deferring them would deadlock the cluster. |
| FR-005 | The `POST /lifecycle/vscode-tunnel-start` handler MUST skip the start with a clear response body (indicating the cluster is still starting up) when `postActivationReady === false`. No in-process watcher is installed and no device-code auth is initiated. | P1 | Q7/A. Supersedes Batch 1 / Q4's defer-and-fire. |
| FR-006 | The cloud/UI MUST hide or disable the "Connect with VS Code Desktop" button while `postActivationReady === false` on the cluster metadata. | P1 | Cross-repo contract with generacy-cloud (companion issue). |
| FR-007 | Post-restart auto-recovery MUST work through existing machinery: the fresh orchestrator's `BootResumeService` (already gated on `activated && postActivationComplete`) dispatches `vscode-tunnel-start`, and `setRetainedTunnelEvent` (orchestrator/src/routes/retained-tunnel-event.ts) retains an `authorization_pending` event for modal replay. No new persistence layer is added. | P2 | Verified working today — snappoll dispatched both lifecycle actions ~4s after self-restart. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | First-time-tunnel-connect success rate on freshly activated wizard clusters. | 100% of authorized device codes persist (no silent loss to self-restart SIGTERM). | Reproduce the snappoll scenario end-to-end; confirm `token.json` is present in the `vscode-cli-state` volume after a single authorization. |
| SC-002 | Latency from marker appearing to `postActivationReady === true` on the cloud side. | ≤5s p95 (matches `codeServerReady` behavior post-#586/#596). | Instrument `sendMetadata()` invocation on marker-appearance; compare against cloud-received timestamp on `cluster.metadata`. |
| SC-003 | Number of device codes burned per successful first-time connect. | 1 (single authorization, single code). | Count `authorization_pending` events emitted on `cluster.vscode-tunnel` between fresh activation and `connected` — should be 1 on the happy path. |
| SC-004 | Zero `bootstrap-complete` handler regressions on non-wizard / local clusters. | Local `generacy launch` clusters continue to auto-start the tunnel via the in-handler path. | On a local cluster, verify `postActivationReady === true` immediately (via `NOT activated` branch) and that step (d) fires as today. |

## Assumptions

- The existing cluster-image entrypoints (both `cluster-base` and `cluster-microservices`) already write `/var/lib/generacy/post-activation-restart-done` immediately before `docker restart` (log line: "Wrote restart marker"). No companion cluster-image PR is required (Q5/D).
- The `generacy-data` volume is mounted into the orchestrator container at boot, so the marker file is readable from within the orchestrator process.
- The fresh orchestrator's `BootResumeService` reliably dispatches `vscode-tunnel-start` post-restart when `activated && postActivationComplete` — confirmed by snappoll orchestrator logs at 15:53:30.
- The retained `authorization_pending` event mechanism (orchestrator/src/routes/retained-tunnel-event.ts) already replays the current device code to the modal on open.

## Out of Scope

- The in-process `fs.watch` defer-and-fire mechanism (Batch 1 / Q4) is explicitly dropped from the design — an in-process watcher armed on the OLD orchestrator either dies with the restart or trips inside the sub-second pre-restart window and reproduces the same bug from a different entry point.
- Cross-restart persistence of pending tunnel starts (Q7/B). The existing `BootResumeService` + retained `authorization_pending` event cover the post-settle recovery path automatically.
- An explicit `cluster.vscode-tunnel: { status: 'lost', reason: 'orchestrator-restarted' }` observability event (Q7/C) is a reasonable optional follow-up but is not required to close this bug.
- Reducing the device-code burn on the post-restart `BootResumeService` auto-start when no user is watching the modal — the auto-start currently burns one code even without a viewer and dies at the 5-minute `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`. Tracked as a future issue.
- Companion cluster-image changes (Q5/D) — the generacy repo alone owns this fix.

---

*Generated by speckit*
