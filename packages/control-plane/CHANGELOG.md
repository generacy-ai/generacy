# @generacy-ai/control-plane

## 0.3.0

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
  - @generacy-ai/config@0.2.0

## 0.2.0

### Minor Changes

- 95f3c52: Add `prepare-workspace` lifecycle action: a subset of `bootstrap-complete` that unseals whatever wizard credentials are currently stored and writes the post-activation sentinel, but **does not** start code-server or VS Code Tunnel. Intended for use by the wizard's GitHubAppInstall step so the cluster's workspace clone runs in parallel with the remaining wizard steps (peer-repos, app-config), making the app-config manifest available by the time the user reaches that wizard step. `bootstrap-complete` remains the action fired by ReadyStep at the end of the wizard.

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

- Updated dependencies [6779a85]
  - @generacy-ai/credhelper@0.1.1
