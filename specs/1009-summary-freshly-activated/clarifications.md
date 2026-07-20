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

**Answer**: *Pending*

### Q2: Readiness signal source in orchestrator
**Context**: FR-004 says the settled bit must "propagate to the cloud within the existing metadata heartbeat window (seconds, not the 60s heartbeat)" and points at "#586's `codeServerReady` propagation pattern." In practice, #586/#596 landed as: `/health` returns `codeServerReady` via a live socket probe; `RelayBridge.collectMetadata()` reads the same probe; transitions trigger `sendMetadata()` for seconds-latency propagation instead of waiting on the 60s heartbeat. This bit is a **file marker**, not a socket, so the analog is `fs.existsSync` / `fs.stat`. Multiple valid mirror choices exist.
**Question**: How should the orchestrator surface the post-activation-settled bit?
**Options**:
- A: Full mirror of #586/#596: `/health` returns the bit from a live filesystem check; `collectMetadata()` reads the same; when the marker appears, trigger `sendMetadata()` for immediate propagation (e.g., a one-shot `fs.watch` on the marker path installed at boot if it's not yet present).
- B: Probe-only: `/health` and `collectMetadata()` read via `fs.existsSync`; rely on the standard 60s metadata heartbeat to carry the transition. Simpler; slower first-tunnel-ready surface (worst case ~60s).
- C: Push-only: A one-shot watcher on the marker path fires `sendMetadata()` once when it appears; `/health` does not surface the bit. Cloud only learns via relay push.

**Answer**: *Pending*

### Q3: Field name on the wire
**Context**: The spec references `codeServerReady` and `controlPlaneReady` as prior art (#586, #624) but does not name the new field. This name is a cross-repo contract (generacy + generacy-cloud) and must be agreed before either side ships. Nothing in the spec picks it.
**Question**: What is the canonical field name on `ClusterMetadataPayload` (and, per Q2, potentially the `/health` response) for the settled bit?
**Options**:
- A: `postActivationSettled` (matches spec's prose — "post-activation settled").
- B: `postActivationRestartDone` (mirrors the marker filename exactly).
- C: `postActivationReady` (parallel construction with `codeServerReady`, `controlPlaneReady`).
- D: Other (please supply).

**Answer**: *Pending*

### Q4: Pre-settled lifecycle-action handling
**Context**: FR-002 says `bootstrap-complete` MUST NOT auto-start the VS Code tunnel pre-settled. FR-005 says a `vscode-tunnel-start` request during the pre-settled window MUST NOT attempt device-code auth (and MAY re-emit `starting` on settle). Neither FR pins the **response** contract to the caller, nor whether the request is discarded, deferred, or queued. This determines UI behavior on retries and how the cloud reasons about lifecycle POST results.
**Question**: When either `bootstrap-complete` (auto-start path) or `vscode-tunnel-start` (user-initiated path) arrives at the control-plane before the settled marker exists, what does the handler do?
**Options**:
- A: **Defer-and-fire**: Return `202 Accepted` (or 200 with `{ deferred: true }`), install a one-shot watcher on the marker; when the marker appears, fire the tunnel start automatically. Idempotent if multiple deferred requests arrive.
- B: **Refuse**: Return `409 Conflict` (or similar 4xx) with `{ code: 'POST_ACTIVATION_NOT_SETTLED' }`. Caller (cloud/UI) is responsible for retry once metadata shows settled. No control-plane-side state carried between the refused request and the eventual start.
- C: **Accept-no-op**: Return 200; do nothing; caller must re-issue after settle. UI drives everything via metadata.
- D: Split behavior — `bootstrap-complete` gets one treatment (e.g., always defer, since it's system-triggered), `vscode-tunnel-start` gets another (e.g., refuse, since it's user-driven and the UI is expected to gate on FR-003).

**Answer**: *Pending*

### Q5: Cluster-image variants in scope
**Context**: Root cause explicitly names both `cluster-microservices/.devcontainer/generacy/scripts/entrypoint-post-activation.sh` **and** `cluster-base` as sources of the self-restart. The FR set is silent on which variant(s) must ship the fix. Wizard-provisioned clusters (the failure mode #1009 was reported on) currently run one of these variants selected via `CLUSTER_VARIANT`. Companion cluster-image PRs may or may not be required alongside the generacy-repo fix.
**Question**: Which cluster-image variant(s) must ship the marker-write mechanism (Q1) and any companion entrypoint changes?
**Options**:
- A: **Both** `cluster-base` and `cluster-microservices` (paired companion PRs; #1009 does not merge until both cluster-image PRs merge).
- B: **Only `cluster-microservices`** (the reproduction cluster `snappoll` and both known affected users were on microservices; base can follow if it's still affected).
- C: **Only `cluster-base`** (base is the default wizard variant).
- D: **Neither** — the generacy repo alone owns the fix (e.g., orchestrator startup writes its own marker; no entrypoint changes needed on either image).

**Answer**: *Pending*
