# @generacy-ai/activation-client

## 0.3.0

### Minor Changes

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

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.
