# @generacy-ai/control-plane

## 0.4.0

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

### Patch Changes

- 967718e: fix(control-plane): defer the post-activation sentinel until the GitHub token is sealed

  `prepare-workspace` wrote the post-activation sentinel unconditionally, even
  when `writeWizardEnvFile` had not yet produced a `GH_TOKEN`. Because the
  post-activation watcher is one-shot, this fired the deferred repo clone before
  the GitHub token existed — the clone of a private repo authenticated with
  nothing, produced no workspace, and never re-ran when the token landed via
  `bootstrap-complete`. `writeWizardEnvFile` now reports `hasGitHubToken`, and
  `prepare-workspace` only writes the sentinel once the token is present
  (otherwise it defers to `bootstrap-complete`, which fires with the full
  credential set).

- 30ce711: fix(control-plane): report the actual VS Code tunnel name, not the requested one

  The tunnel name is derived from the stable project id (#618), so deleting and
  redeploying a cluster for the same project makes the new Droplet request a name
  that's still registered to the (now-destroyed) previous Droplet. `code tunnel`
  reports "name already taken" and silently falls back to a random name — but the
  manager kept emitting the requested name, so the cloud persisted the wrong
  `vscodeTunnelName` and vscode.dev deep-linked to the dead tunnel ("Timeout
  connecting to relay").

  `VsCodeTunnelProcessManager` now parses the actual registered name from the
  `https://vscode.dev/tunnel/<name>/…` connection URL and reports that (falling
  back to the requested name only if no URL was seen), so the cloud/UI always
  points at the tunnel that's actually running.

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
