# @generacy-ai/cluster-relay

## 0.4.0

### Minor Changes

- 472cea0: Gate VS Code tunnel on post-activation restart settling (#1009).

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

## 0.3.0

### Minor Changes

- 6f74140: feat: per-cluster tunnel name + identity for multi-cluster support (#744)

  Adds cluster/CLI/orchestrator-side support for multiple, user-named clusters
  per project.

  - `deriveTunnelName` is now keyed on the per-cluster UUID (not the projectId),
    so each cluster in a project gets a distinct, ≤20-char, lowercase,
    letter-initial tunnel name. The constraint is documented next to the helper.
  - `generacy launch --name <name>` (and the scaffolder) accept an optional human
    cluster name; when omitted, a default `<sanitized-project>-local-<n>` is
    generated. The name is fixed at creation and persisted into the scaffolded
    cluster identity.
  - The orchestrator cluster identity now carries the cluster UUID and display
    name, surfacing the name in registration so the cloud can show it, while the
    short derived tunnel name stays decoupled from the display name.
  - Deleting/stopping a cluster now unregisters/turns off its dev tunnel so the
    name is freed for reuse.

## 0.2.0

### Minor Changes

- 007dc5f: Worker-scale architecture: catch `stable` up with `preview` after ~10 feature
  PRs shipped without per-PR changesets. The whole story is around treating
  worker count as host capacity rather than project intent.

  Highlights:

  - `@generacy-ai/control-plane` — Engine API client + worker-scaler refactor
    (no compose-file dependency); merged cluster.yaml / cluster.local.yaml
    read helper; app-config wired to the merged view; `enumerateWorkers`
    and `computeProjectName` exported for orchestrator use (#707, #711, #713).
  - `@generacy-ai/orchestrator` — metadata reports actual running container
    count via Engine API enumeration; Docker container-event subscription
    with reconnect+backoff for sub-10s responsiveness; CWD fix for
    workspace-relative file reads; reads `GENERACY_INITIAL_WORKERS` at boot
    (#715, #717).
  - `@generacy-ai/generacy` (CLI) — `--workers <N>` flag and interactive
    prompt at launch; tier-cap-bounded resolver (`CLI_FALLBACK_TIER_CAP=8`,
    `SUGGESTED_FROM_HOST=2`); no-TTY default with warning; reconcile path
    reads merged config and writes `.env`'s `WORKER_COUNT` ahead of compose
    (#713, #717).
  - `@generacy-ai/activation-client` — device-code poll body carries the
    host-chosen `workers` value so the cloud can set `targetWorkers` at
    activation (#717).
  - `@generacy-ai/config` — new `readMergedClusterConfig` helper providing
    shallow per-top-level-key merge of `cluster.yaml` + `cluster.local.yaml`
    (local wins); the canonical reader used by orchestrator's relay-bridge
    and control-plane's app-config / worker-scaler (#711).
  - `@generacy-ai/cluster-relay` — wire-format rename `workerCount` →
    `workers` to match the cluster.yaml schema flatten (#697 on cloud side).

  Minor across the board because the API surface is additive (new flags,
  new helpers, new fields) but substantial enough that semver-patch would
  undersell the scope.

## 0.1.2

### Patch Changes

- da4825e: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.

## 0.1.1

### Patch Changes

- 28428ae: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.
