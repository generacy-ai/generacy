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

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- **Marker write mechanism (Q1)**: `entrypoint-post-activation.sh` in both `cluster-base` and `cluster-microservices` already writes `/var/lib/generacy/post-activation-restart-done` immediately before issuing `docker restart "$self_container"` on itself ("Wrote restart marker" log line). The sub-second window between the marker write and the SIGTERM is covered by the Q4 defer-and-fire handler. No cluster-image change is required.
- **Local-cluster fallback (Q1)**: On non-wizard / local `generacy launch` clusters, `post-activation-complete` is never written and no self-restart ever runs. The readiness bit MUST treat this as already-settled — computed as `restart-done present OR post-activation-complete absent` — otherwise the tunnel button would be permanently ungated on local clusters.
- **Marker volume**: `/var/lib/generacy/` is on the `generacy-data` volume, already mounted into the orchestrator container; no compose change is needed to READ the marker.
- **Readiness surface (Q2)**: The bit is exposed the same way `codeServerReady` (#586/#596) and `controlPlaneReady` (#624) are: `/health` reads it via a filesystem check (`fs.existsSync`/`fs.stat`), `RelayBridge.collectMetadata()` reads it the same way, and a one-shot `fs.watch` installed at boot (only if the marker is not already present) fires `sendMetadata()` when it appears — giving seconds-latency propagation instead of waiting for the 60s heartbeat.
- **Wire field name (Q3)**: `postActivationReady` on `ClusterMetadataPayload` (types/relay.ts, types/api.ts) and on the `/health` response, parallel to `codeServerReady` / `controlPlaneReady`. Deliberately decoupled from the marker filename so the cross-repo wire contract is stable if the write mechanism ever changes.
- **Pre-settled lifecycle-action handling (Q4)**: Both `bootstrap-complete` (auto-start path) and `vscode-tunnel-start` (user-initiated path) use the same defer-and-fire treatment in the control-plane. Requests arriving before the settled marker exists return `200` with `{ deferred: true }`, install a one-shot marker watcher, and fire `tunnelManager.start()` exactly once when the marker appears. Multiple deferred requests collapse to a single pending start (idempotent). This is belt-and-suspenders behind the FR-003 UI gate and avoids adding a new 409/CONFLICT variant to the `ControlPlaneError` enum (control-plane/src/errors.ts).
- **Scope (Q5)**: This fix ships entirely in the `generacy` repo. Both cluster-image variants already write the marker via their existing entrypoints; the orchestrator only needs to READ it. Companion cluster-base and cluster-microservices PRs are NOT required.
- **Companion cloud change**: The generacy-cloud UI/API must consume the new `postActivationReady` field to gate the "Connect with VS Code Desktop" button (FR-003). That change ships separately in the generacy-cloud repo and is out of scope for this issue.

## Out of Scope

- Companion changes to `cluster-base` and `cluster-microservices` entrypoints (Q5 = D — not required).
- Cloud-side UI/API wiring that consumes `postActivationReady` to gate the tunnel button (separate generacy-cloud issue).
- Recovery flow for existing broken clusters where a mid-restart auth already destroyed `token.json` (documented manual recovery in spec §Evidence is sufficient for now).
- Adding a 409/CONFLICT variant to the `ControlPlaneError` enum (rejected under Q4 = A in favor of `{ deferred: true }`).

---

*Generated by speckit*
