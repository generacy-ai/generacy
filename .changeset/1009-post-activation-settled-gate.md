---
"@generacy-ai/orchestrator": minor
"@generacy-ai/control-plane": minor
"@generacy-ai/cluster-relay": minor
---

Gate VS Code tunnel on post-activation restart settling (#1009).

Freshly activated wizard clusters used to start the VS Code tunnel during the
brief window before the container's post-activation self-restart, so a
device-code authorization completed by the user in that window was SIGTERM'd
away with the process — token never persisted, tunnel stuck.

`@generacy-ai/orchestrator`: new `PostActivationSettledMonitor` (one-shot
`fs.watch` on `/var/lib/generacy/post-activation-restart-done`) pushes an
immediate `sendMetadata()` when the marker appears. `/health` and
`ClusterMetadataPayload.postActivationReady` compute
`(NOT activated) OR (marker present)` via a shared sync predicate — matches
the `codeServerReady` / `controlPlaneReady` push-latency pattern.

`@generacy-ai/control-plane`: `POST /lifecycle/vscode-tunnel-start` now
returns a 200 skip response
(`{ accepted: false, reason: 'post-activation-not-settled', ... }`) when the
cluster is still in the pre-restart window, and the `bootstrap-complete`
handler skips its auto-tunnel-start step (d) in the same condition. Steps
(a) `writeWizardEnvFile`, (b) sentinel write, and (c) `codeServerManager.start()`
are unchanged — they are what causes the marker to eventually exist.

`@generacy-ai/cluster-relay`: `ClusterMetadata` + `HealthData` gain
`postActivationReady?: boolean` and propagate it through `collectMetadata()`
so cloud-side UI can gate the "Connect with VS Code Desktop" button.

Local `generacy launch` clusters (no key file) are always reported settled
(`postActivationReady: true`) — the fix does not gate them.
