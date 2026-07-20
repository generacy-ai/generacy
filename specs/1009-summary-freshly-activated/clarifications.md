# Clarifications

## Batch 1 — 2026-07-20

### Q1: Marker write mechanics
**Context**: The spec assumes a marker file at `/var/lib/generacy/post-activation-restart-done` "already exists and is written by `entrypoint-post-activation.sh` after the self-restart completes." But the script that calls `docker restart "$self_container"` is killed by that same restart — it cannot write anything after triggering it. And no such marker file exists in this repo today (grep confirms only spec.md references the string). Implementation must know exactly where this marker comes from before FR-006/FR-007 semantics can be pinned down.
**Question**: Which mechanism writes `/var/lib/generacy/post-activation-restart-done`, and when?
**Options**:
- A: `entrypoint-post-activation.sh` writes the marker **immediately before** issuing `docker restart` on itself (so on the next boot, the fresh orchestrator sees the marker present — "restart-scheduled" would be the honest name, but the invariant matches).
- B: A new post-restart hook on the fresh orchestrator container writes the marker on boot when it detects it's the post-activation follow-up boot (e.g., `post-activation-complete` present but `post-activation-restart-done` absent → write it now).
- C: The orchestrator's own startup code writes the marker on the first boot after `post-activation-complete` was set, gated on a "this is not the pre-restart boot" heuristic.
- D: Some other mechanism (please describe).

**Answer**: A — Keep the existing write: `entrypoint-post-activation.sh` already writes `/var/lib/generacy/post-activation-restart-done` immediately before `docker restart "$self_container"` (log line: "Wrote restart marker"). Its "restart-scheduled" semantics leave only a sub-second pre-restart window.

**CORRECTION (superseded by Batch 2 answer)**: The original fallback predicate `restart-done present OR post-activation-complete absent` was WRONG — on a fresh wizard cluster `post-activation-complete` is ALSO absent at `bootstrap-complete` time (the post-activation hook writes it later, just before the restart), so that predicate evaluates to `settled = true` exactly when the gate is most needed. The correct discriminator is `activated`, which the codebase already computes via `existsSync(keyFilePath)` in `PostActivationRetryService.checkPostActivationState()`:

    postActivationReady = (NOT activated) OR (post-activation-restart-done present)

Truth table: local/non-activated cluster → ready immediately (no restart is ever coming); wizard cluster pre-restart → activated && marker absent → NOT ready (gate active); wizard cluster post-restart → marker present → ready. Use this predicate everywhere `postActivationReady` is computed (Q2's `/health` + `collectMetadata()` sites).

Note: Q4's defer-and-fire mechanism is superseded by Batch 2 / Q7 — the in-process watcher is not needed (and is actively harmful). Use "skip pre-settled" instead.

### Q2: Readiness signal source in orchestrator
**Context**: FR-004 says the settled bit must "propagate to the cloud within the existing metadata heartbeat window (seconds, not the 60s heartbeat)" and points at "#586's `codeServerReady` propagation pattern." In practice, #586/#596 landed as: `/health` returns `codeServerReady` via a live socket probe; `RelayBridge.collectMetadata()` reads the same probe; transitions trigger `sendMetadata()` for seconds-latency propagation instead of waiting on the 60s heartbeat. This bit is a **file marker**, not a socket, so the analog is `fs.existsSync` / `fs.stat`. Multiple valid mirror choices exist.
**Question**: How should the orchestrator surface the post-activation-settled bit?
**Options**:
- A: Full mirror of #586/#596: `/health` returns the bit from a live filesystem check; `collectMetadata()` reads the same; when the marker appears, trigger `sendMetadata()` for immediate propagation (e.g., a one-shot `fs.watch` on the marker path installed at boot if it's not yet present).
- B: Probe-only: `/health` and `collectMetadata()` read via `fs.existsSync`; rely on the standard 60s metadata heartbeat to carry the transition. Simpler; slower first-tunnel-ready surface (worst case ~60s).
- C: Push-only: A one-shot watcher on the marker path fires `sendMetadata()` once when it appears; `/health` does not surface the bit. Cloud only learns via relay push.

**Answer**: A — Full mirror of the #586/#596 `codeServerReady` pattern. Both `/health` (routes/health.ts) and `RelayBridge.collectMetadata()` (services/relay-bridge.ts) compute the bit via a filesystem check (`fs.existsSync`/`fs.stat` on the marker, plus the Q1 local-cluster fallback), and a one-shot `fs.watch` on the marker path installed at boot (only when the marker is not yet present) fires `sendMetadata()` when it appears — giving the same seconds-latency push the socket probes get. Reject B: its reliance on the ~60s heartbeat would leave the tunnel button dead for up to a minute after settle, in the exact first-connect flow this bug is about.

### Q3: Field name on the wire
**Context**: The spec references `codeServerReady` and `controlPlaneReady` as prior art (#586, #624) but does not name the new field. This name is a cross-repo contract (generacy + generacy-cloud) and must be agreed before either side ships. Nothing in the spec picks it.
**Question**: What is the canonical field name on `ClusterMetadataPayload` (and, per Q2, potentially the `/health` response) for the settled bit?
**Options**:
- A: `postActivationSettled` (matches spec's prose — "post-activation settled").
- B: `postActivationRestartDone` (mirrors the marker filename exactly).
- C: `postActivationReady` (parallel construction with `codeServerReady`, `controlPlaneReady`).
- D: Other (please supply).

**Answer**: C — `postActivationReady`. Parallel construction with the existing `codeServerReady` / `controlPlaneReady` booleans on `ClusterMetadataPayload` (types/relay.ts, types/api.ts) and the `/health` response, and deliberately decoupled from the marker filename so the cross-repo wire contract survives any future change to Q1's write mechanism.

### Q4: Pre-settled lifecycle-action handling
**Context**: FR-002 says `bootstrap-complete` MUST NOT auto-start the VS Code tunnel pre-settled. FR-005 says a `vscode-tunnel-start` request during the pre-settled window MUST NOT attempt device-code auth (and MAY re-emit `starting` on settle). Neither FR pins the **response** contract to the caller, nor whether the request is discarded, deferred, or queued. This determines UI behavior on retries and how the cloud reasons about lifecycle POST results.
**Question**: When either `bootstrap-complete` (auto-start path) or `vscode-tunnel-start` (user-initiated path) arrives at the control-plane before the settled marker exists, what does the handler do?
**Options**:
- A: **Defer-and-fire**: Return `202 Accepted` (or 200 with `{ deferred: true }`), install a one-shot watcher on the marker; when the marker appears, fire the tunnel start automatically. Idempotent if multiple deferred requests arrive.
- B: **Refuse**: Return `409 Conflict` (or similar 4xx) with `{ code: 'POST_ACTIVATION_NOT_SETTLED' }`. Caller (cloud/UI) is responsible for retry once metadata shows settled. No control-plane-side state carried between the refused request and the eventual start.
- C: **Accept-no-op**: Return 200; do nothing; caller must re-issue after settle. UI drives everything via metadata.
- D: Split behavior — `bootstrap-complete` gets one treatment (e.g., always defer, since it's system-triggered), `vscode-tunnel-start` gets another (e.g., refuse, since it's user-driven and the UI is expected to gate on FR-003).

**Answer**: A — Defer-and-fire, unified for both the `bootstrap-complete` auto-start and the user-initiated `vscode-tunnel-start` paths. A request arriving before the settled marker exists returns 200 with `{ deferred: true }`, installs a one-shot watcher on the marker, and fires the real `tunnelManager.start()` once it appears; idempotent — multiple deferred requests collapse to a single pending start. Rationale: belt-and-suspenders behind the FR-003 UI gate; subsumes FR-002 (auto-start simply becomes deferred rather than suppressed) and satisfies FR-005's "MAY re-emit `starting` on settle"; and it avoids inventing a new error code — the `ControlPlaneError` enum (control-plane/src/errors.ts) has no 409/CONFLICT, which a refuse-path (B) would require adding.

**SUPERSEDED by Batch 2 / Q7**: The in-process `fs.watch` deferral is dropped from the design — armed on the OLD process, it either dies with the restart or trips inside the sub-second pre-restart window and gets SIGTERM'd mid-device-auth, reproducing #1009 from a new entry point. Replaced by "skip pre-settled" on both `bootstrap-complete` (Q6/D: skip step d, no watcher) and `vscode-tunnel-start` (Q7/A: skip with clear response, no watcher). The fresh orchestrator's `BootResumeService` + retained `authorization_pending` event cover the post-settle path automatically.

### Q5: Cluster-image variants in scope
**Context**: Root cause explicitly names both `cluster-microservices/.devcontainer/generacy/scripts/entrypoint-post-activation.sh` **and** `cluster-base` as sources of the self-restart. The FR set is silent on which variant(s) must ship the fix. Wizard-provisioned clusters (the failure mode #1009 was reported on) currently run one of these variants selected via `CLUSTER_VARIANT`. Companion cluster-image PRs may or may not be required alongside the generacy-repo fix.
**Question**: Which cluster-image variant(s) must ship the marker-write mechanism (Q1) and any companion entrypoint changes?
**Options**:
- A: **Both** `cluster-base` and `cluster-microservices` (paired companion PRs; #1009 does not merge until both cluster-image PRs merge).
- B: **Only `cluster-microservices`** (the reproduction cluster `snappoll` and both known affected users were on microservices; base can follow if it's still affected).
- C: **Only `cluster-base`** (base is the default wizard variant).
- D: **Neither** — the generacy repo alone owns the fix (e.g., orchestrator startup writes its own marker; no entrypoint changes needed on either image).

**Answer**: D — The generacy repo alone owns the fix. Under Q1=A the marker is already written by the existing cluster-image entrypoint in BOTH variants, so the orchestrator only needs to READ `/var/lib/generacy/post-activation-restart-done` (on the `generacy-data` volume, already mounted) and surface the bit per Q2/Q3 — no companion cluster-base or cluster-microservices PR is required. (Revisit only if a future change adopts Q1=B, which would move the write into both entrypoints.)

## Batch 2 — 2026-07-20

### Q6: Deferral scope inside the `bootstrap-complete` handler
**Context**: Q4 says defer-and-fire applies to "the `bootstrap-complete` auto-start." But the handler at `packages/control-plane/src/routes/lifecycle.ts:168` does four things on a fresh wizard cluster: (a) unseal wizard creds → write `/var/lib/generacy/wizard-credentials.env`; (b) write the `POST_ACTIVATION_TRIGGER` sentinel that fires `post-activation-watcher.sh` → `entrypoint-post-activation.sh` → workspace clone → **write of `post-activation-restart-done` → `docker restart`**; (c) `codeServerManager.start()` (fire-and-forget); (d) `await tunnelManager.start()`. Steps (a) and (b) **must** run pre-settled — they are what causes the marker to eventually exist, so deferring them deadlocks the cluster. Q4 doesn't pin which sub-actions defer, and the answer choice (a vs. b vs. c vs. d below) determines whether the fix works at all and what code shape lands.
**Question**: When `POST /lifecycle/bootstrap-complete` arrives with the settled marker absent, which sub-actions of the handler defer, and which fire immediately?
**Options**:
- A: Only step (d) — the `tunnelManager.start()` — defers. Steps (a), (b), (c) fire immediately as today. Code-server auto-start is considered restart-safe (state lives on `code-server` volume; a mid-start SIGTERM is recoverable by a subsequent start).
- B: Steps (c) and (d) both defer. Steps (a) and (b) always fire.
- C: Remove the auto-`tunnelManager.start()` (step d) from `bootstrap-complete` entirely — no defer path, no in-handler start. Rely on the existing `BootResumeService` (which fires `vscode-tunnel-start` on fresh-orch boot when `activated && postActivationComplete`, see `packages/orchestrator/src/services/boot-resume-service.ts`) to start the tunnel after the self-restart completes. Q4's defer-and-fire then applies only to the user-initiated `POST /lifecycle/vscode-tunnel-start` path.
- D: Keep step (d) as-is (no defer), but skip it when the settled marker is absent (log + short-circuit; no watcher installed). Same rationale as C but touches less code — `BootResumeService` covers the fresh-orch case.

**Answer**: D — Keep step (d) in the handler but short-circuit it (log + skip, NO watcher installed) when the settled predicate is false. Steps (a), (b), (c) always fire immediately. Rejecting C because it regresses local clusters: `runPostActivationBranch` (orchestrator/src/services/post-activation-dispatch.ts) only reaches `BootResumeService.triggerBootResume()` when `state.activated && state.postActivationComplete`, and `activated` = cluster-API-key file present. A local / non-cloud-activated cluster therefore never gets boot-resume, so removing the in-handler start entirely would leave nothing to auto-start its tunnel. D keeps that path working while closing the race on wizard clusters.

Resulting flow on a fresh wizard cluster: `bootstrap-complete` fires (a)(b)(c), skips (d); the post-activation hook clones, writes the marker, and restarts; the fresh orchestrator's boot-resume dispatches `vscode-tunnel-start` post-settle. Verified this already happens today — snappoll's orchestrator logged "Boot resume: control-plane ready — dispatching lifecycle actions" → "both lifecycle actions dispatched" at 15:53:30, ~4s after the self-restart.

### Q7: Deferred fire vs. the sub-second pre-restart window
**Context**: Q4 installs an in-process one-shot `fs.watch` on `post-activation-restart-done`. Per Q1, `entrypoint-post-activation.sh` writes that marker **immediately before** `docker restart "$self_container"` — a sub-second window. So a request that arrived pre-settled and was deferred by the OLD orchestrator process will trip its watcher during that sub-second window, execute `tunnelManager.start()`, and be SIGTERM'd during device-code auth — which is precisely #1009's failure mode reproduced from a different entry point. The FRESH orchestrator that boots post-restart does not inherit the old process's watchers. So the defer path on the OLD process is functionally lost, not saved. How is the user-initiated `POST /lifecycle/vscode-tunnel-start` request actually serviced end-to-end?
**Question**: When a user-initiated `vscode-tunnel-start` arrives pre-settled and is deferred, what mechanism actually starts the tunnel *safely* (i.e., not inside the sub-second pre-restart window)?
**Options**:
- A: **UI-retry model.** The FR-003 UI gate is the primary safety — the cloud/UI hides the tunnel button until `postActivationReady === true`, so a request should never arrive pre-settled in normal use. Defer-and-fire is a redundant server-side backstop for UI races; when the OLD orchestrator's deferred fire dies with the restart, the auth is lost, and the user must click again post-settled. UI retry happens naturally because the button re-enables once metadata reports settled.
- B: **Cross-restart persistence.** On deferral, the control-plane writes a small `/var/lib/generacy/pending-vscode-tunnel-start` marker (survives restart via the mounted `generacy-data` volume). The FRESH orchestrator's control-plane inspects this marker on boot and, once `postActivationReady === true`, completes the deferred `tunnelManager.start()`. Marker is cleared on start success or explicit user cancel.
- C: **Explicit `deferred:lost` emission.** Deferred fire on the OLD process is best-effort; when the process receives SIGTERM with a still-armed watcher, it emits `cluster.vscode-tunnel: { status: 'lost', reason: 'orchestrator-restarted' }` on the relay so the cloud can display "please retry" to the user (or auto-retry). Post-restart, the fresh orch's normal flow takes over. No disk persistence.
- D: **Grace-window fire.** Watcher waits ~N seconds after marker appears before firing `tunnelManager.start()`. If the process survives the grace, the fire is safe (restart didn't happen); if the process is SIGTERM'd during grace, the deferred is lost (falls back to UI retry per option A). Trades off a small delay for a large safety margin.

**Answer**: A — UI-retry model. Do NOT install the in-process `fs.watch` deferral; a pre-settled `vscode-tunnel-start` should skip with a clear response (same posture as Q6/D) so the cloud/UI can show "cluster still starting up". This SUPERSEDES Batch 1 / Q4's defer-and-fire — an in-process watcher armed on the OLD process either dies with the restart or trips inside the sub-second pre-restart window and gets SIGTERM'd mid-device-auth, reproducing #1009 from a new entry point. Drop that mechanism; "skip pre-settled" replaces "defer pre-settled" on both paths. Cross-restart persistence (B) is unnecessary: the fresh orchestrator's `BootResumeService` already dispatches `vscode-tunnel-start` unconditionally once `activated && postActivationComplete` hold (both true post-restart), and `setRetainedTunnelEvent` (orchestrator/src/routes/retained-tunnel-event.ts) retains an `authorization_pending` event — device code included — for replay. Users opening the modal after settle see a live device code without clicking anything; recovery is largely automatic. D (grace-window) is a timing hack that reintroduces a race. C's `lost` emission is a reasonable OPTIONAL follow-up for observability (reuse existing `cluster.vscode-tunnel` error event with a distinct reason) but out of scope for this bug. Non-blocking future-issue observation: post-restart boot-resume auto-start burns a device code even when no one is watching the modal and dies at the 5-minute `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` — the retained-event replay covers users who open the modal within that window; past it they must click once more.
