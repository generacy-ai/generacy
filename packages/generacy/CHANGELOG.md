# @generacy-ai/generacy

## 0.3.1

### Patch Changes

- 0a0f1ac: Share the `.claude` directory volume between orchestrator and workers in scaffolded clusters.

  The generated compose mounted only `~/.claude.json` (a file) and no shared
  `/home/node/.claude` directory volume, so workers never inherited the
  orchestrator's Claude auth, speckit slash-commands, or conversation history.
  Every spec-kit phase launched an unauthenticated Claude CLI, exited "Not logged
  in" in <1s, and the phase runner committed an empty phase — producing PRs with
  phase commits but no real artifacts.

  Align the generated compose with the canonical cluster-base layout: add a shared
  `claude-config:/home/node/.claude` volume on both services, stop mounting
  `workspace` on the worker (per-job checkouts are container-local), and mount
  `shared-packages` read-only on the worker. Only the `.claude` directory is
  volume-mounted — never the `.claude.json` file path (preserving the #737 fix).

## 0.3.0

### Minor Changes

- c8bdfa0: Add pre-approved device-code activation for managed cloud clusters.

  The cloud can now bake a single-use, short-TTL RFC 8628 device code into a
  cluster's `.env` (`GENERACY_PRE_APPROVED_DEVICE_CODE`), threaded through the
  launch/deploy/cluster scaffolders via a new optional `preApprovedDeviceCode`
  config field. On first boot, the orchestrator's `activate()` redeems the
  pre-approved code directly — skipping `requestDeviceCode` — and falls back to
  the interactive device-code flow on terminal failure rather than crash-looping.

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

### Patch Changes

- e429d7f: Fix docker-compose scaffolding for `claudeConfigMode: 'volume'` (deploy/cloud). Previously a named volume was mounted onto the `/home/node/.claude.json` file path, which Docker rejects with "is not a directory". The scaffolder now writes a `claude.json` file next to the compose file and binds it (`./claude.json:/home/node/.claude.json`), chowning it to `1000:1000` (best-effort). `deploy` likewise ensures `claude.json` exists on the remote VM owned by `1000:1000` before `compose up`.

## 0.2.2

### Patch Changes

- 2cc3abc: Catch stable up after #727 (cluster-side `tier-limit-exceeded` handling per
  [generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700))
  and #730 (empty-tier formatter fix per #728) shipped without their own
  changesets. The latter should have been caught by the new gate from #729, but
  slipped through because the PR branch predated the gate's merge by minutes and
  was never rebased — the workflow YAML resolved from the PR's HEAD (old/permissive
  version) rather than from develop's HEAD (new/strict version).

  Per-package summary:

  - `@generacy-ai/activation-client` — **minor** (additive public-API surface):
    new `tier-limit-exceeded` variant on `PollResponseSchema` carrying
    `{ cap, requested, tier }`; new exported `formatTierLimitError` function
    shared between the resolver-side gate and the poll-time reject; empty-tier
    formatter rendering fixed.
  - `@generacy-ai/orchestrator` — **patch**: new `TIER_LIMIT_EXCEEDED`
    `ActivationError` code; activation flow throws on the new poll variant
    with the formatted message.
  - `@generacy-ai/generacy` — **patch**: deploy command's activation poll
    branches on the new variant; `worker-count-resolver` refactored to use
    the shared `formatTierLimitError` instead of an inline string (closes
    the wording-drift between resolver-side and poll-time error messages).

- Updated dependencies [2cc3abc]
  - @generacy-ai/activation-client@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [e69ed75]
  - @generacy-ai/workflow-engine@0.1.2

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

### Patch Changes

- Updated dependencies [007dc5f]
  - @generacy-ai/activation-client@0.2.0
  - @generacy-ai/config@0.2.0

## 0.1.4

### Patch Changes

- e645ad7: Propagate `repos.primaryBranch` from the cloud LaunchConfig into the scaffolded `.generacy/.env` file. Previously the Zod schema silently stripped the field, so `generacy launch` and `generacy deploy` always wrote a `.env` without `REPO_BRANCH=`. The orchestrator container then fell back to `${REPO_BRANCH:-main}` and `git clone --branch main` aborted for any project whose default branch isn't `main`.

## 0.1.3

### Patch Changes

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/orchestrator@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

## 0.1.2

### Patch Changes

- da4825e: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.

## 0.1.1

### Patch Changes

- 28428ae: Initial `stable` dist-tag release. Publishes current main under the `stable` channel so the orchestrator's `npm install @generacy-ai/<pkg>@stable` resolves.
