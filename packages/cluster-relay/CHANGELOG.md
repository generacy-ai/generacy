# @generacy-ai/cluster-relay

## 0.5.0

### Minor Changes

- ff142d7: Make the per-user execution lease path functional in worker mode so concurrent
  cockpit auto sessions can execute in parallel across worker replicas (#1016).

  The cluster-side lease protocol (#418) was dead end-to-end: `cluster-relay`'s
  `RelayMessageSchema` did not include any lease message types, so every inbound
  `lease_response` / `slot_available` / `cluster_rejected` was dropped at the
  Zod parse; the orchestrator additionally expected `lease_granted`/`lease_denied`
  message types the cloud never sends (it sends a single `lease_response`
  discriminated by `status`); and worker mode — the only mode that runs the
  dispatcher — never routed inbound relay messages to its LeaseManager at all.
  Net effect: dispatch was never lease-gated, and a lease denial (had it ever
  arrived) would have paused a replica's polling forever on a missed
  `slot_available`.

  Changes:

  - `cluster-relay`: add lease-protocol message types + schemas matching the
    cloud wire contract (`lease_request`, `lease_release`, `lease_heartbeat`,
    `lease_response`, `slot_available`, `cluster_rejected`, `tier_info`).
  - `orchestrator`: `LeaseManager` consumes `lease_response` (granted / denied /
    released / error), learns the tier's concurrency limit from the denial
    payload (the cloud never emits `tier_info`), sends the `correlationId` the
    cloud requires on `lease_release` (releases were previously refused
    server-side and only expired by TTL), and swallows release acks.
  - `orchestrator`: worker mode wires inbound relay messages to the dispatcher's
    LeaseManager.
  - **Enforcement is opt-in** (`lease.enforce` / `ORCHESTRATOR_LEASE_ENFORCE=true`,
    default OFF): because the lease path has been dead since #418, existing
    clusters run `workers: N` replicas unmetered — silently enabling enforcement
    would cap their effective concurrency at the org's tier limit (free tier: 1).
    With enforcement off, dispatch behaves exactly as before this change.
  - `WorkerDispatcher`: the lease gate engages whenever a lease manager is
    configured (previously also gated on receiving `tier_info`, which never
    arrives). Denials pause claiming and now auto-resume via a
    `denialResumeMs` backstop (new `DispatchConfig` field, default 60s) if the
    `slot_available` broadcast is missed; transient cloud errors re-enqueue and
    retry without pausing; request timeouts fail open (dispatch without a lease)
    so lease-less clouds cannot starve dispatch. The per-replica
    one-job-at-a-time cap is unchanged — parallelism comes from `workers: N`
    container replicas, now properly metered by per-user cloud leases.

- 069536e: Add `cluster.cockpit.reply` member to `RelayMessageSchema` so cloud-sent gate
  acknowledgements stop appearing as `Invalid relay message, skipping` warns.
  Observability-only; correlation deferred to #1059 steps 4–7.
- c4c3f96: Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it (#1077). The orchestrator's `POST /cockpit/gates` and `POST /cockpit/gates/:id/ack` handlers now mint an `frm_<24-hex>` id at request-accept time (before `tryEmitOrRetain`), so the 202 echoes the id, retained frames carry it into the retain queue, and drain emits it verbatim. A caller-supplied `frameId` on the request body overrides the route mint. `@generacy-ai/cluster-relay` gains a new public `registerPendingFrame(frameId, meta)` method and `PendingFrameMeta` export; the `cluster.cockpit.reply` receive branch settles matching pending entries (info log with `ageMs`), quiet-drops unknown ones (info log naming the `frameId`), and evicts on a 30s TTL (debug log). The map is preserved across transient WebSocket disconnects and cleared on `disconnect()`. `@generacy-ai/generacy`'s `GateOpenWireSchema` / `GateOutcomeWireSchema` gain an optional `frameId` field so callers that hand-supply one pass the tool's self-check.

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
