# @generacy-ai/control-plane

## 0.8.0

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

## 0.7.4

### Patch Changes

- 47ba255: Disambiguate "workspace still cloning" from "cloned, no appConfig declared" in the app-config manifest endpoint.

  `GET /control-plane/app-config/manifest` previously returned `null` for both
  states, so the cloud bootstrap UI couldn't tell them apart and had to poll a
  fixed 300s window before falling back to the empty state. The handler now keys
  readiness on the presence of a `.generacy/cluster.yaml` (or `cluster.local.yaml`)
  at the resolved dir: it returns `null` only while the workspace repo hasn't been
  cloned yet, and a non-null empty manifest (`{schemaVersion:'1',env:[],files:[]}`)
  once it's cloned but declares no `appConfig`. The UI can now advance the instant
  the clone lands instead of waiting out the poll window.

## 0.7.3

### Patch Changes

- 405ed96: Fix "Connect with VS Code Desktop" hanging on freshly deployed clusters (#966).

  The `authorization_pending` event from `code tunnel` was silently dropped when the
  orchestrator relay wasn't yet `connected`, so the cloud UI never saw the device code.
  The orchestrator now retains the latest actionable `cluster.vscode-tunnel` event and
  replays it on relay reconnect, `VsCodeTunnelProcessManager.start()` emits a fresh
  `starting` event on user re-trigger while the child is alive, and a distinct 5-minute
  timeout bounds the `authorization_pending` phase.

## 0.7.2

### Patch Changes

- 23befe1: Fix fresh wizard clusters never cloning their repo: the post-activation retry replayed `bootstrap-complete` before `GH_TOKEN` was sealed, burning the one-shot clone watcher (#937).

  On a brand-new wizard-provisioned cluster the state is `activated &&
!postActivationComplete` the instant activation completes — so
  `PostActivationRetryService` fired immediately, ~2 minutes before the user
  finished entering credentials, replaying the `bootstrap-complete` lifecycle
  action. The control-plane wrote the post-activation sentinel unconditionally,
  the one-shot clone watcher fired with no token and (correctly) refused, then
  exited — and nothing was left to consume the credentials when they landed.
  This regressed once #838 made the dispatch block reachable on wizard clusters,
  re-opening the race #739 had closed via the `bootstrap-complete` door it left
  ungated.

  - `@generacy-ai/orchestrator`: `checkPostActivationState()` now only sets
    `needsRetry` when the wizard credentials file exists **and** carries a
    non-empty `GH_TOKEN` (mirroring the guard `entrypoint-post-activation.sh`
    applies). On a fresh pre-credentials cluster the retry defers; genuine
    restart-recovery with creds already sealed still fires.
  - `@generacy-ai/control-plane`: defense-in-depth — the `bootstrap-complete`
    lifecycle handler now gates its sentinel write on `hasGitHubToken`, exactly
    like the sibling `prepare-workspace` handler, so a token-less replay can never
    fire the one-shot clone.

- Updated dependencies [92ca0b4]
  - @generacy-ai/config@0.4.0

## 0.7.1

### Patch Changes

- aef8f58: Fix the VS Code tunnel device-code timeout orphaning the code-tunnel child (#825).

  When a tunnel start reached the 30s device-code timeout, `VsCodeTunnelProcessManager`
  set `status = "error"` but left `this.child` alive, so every later `start()` (the
  cloud "Restart tunnel" button, which is start-only) hit the early-return and silently
  no-oped until the control-plane process restarted. The timeout handler now kills the
  child (SIGTERM with a SIGKILL backstop) so the exit handler clears `this.child`, and
  `start()` is hardened to stop-then-respawn when it finds a stale child resting in an
  `error` / `disconnected` / `stopped` status instead of returning. A `timedOut` flag
  routes the exit-handler cascade past the pending branch so the timeout emits exactly
  one `error` event rather than a second misleading "code tunnel exited" event.

- 09e6d94: Terminate `wizard-credentials.env` with a trailing newline.

  `formatEnvFile()` joined entries with `\n` but omitted a final newline, so any
  later append (by an operator, a script, or a future writer) concatenated onto
  the last key/value pair — corrupting the existing key and silently dropping the
  appended one. The writer now ends the file with `\n`, matching the POSIX
  convention that entrypoints rely on when sourcing the file.

- Updated dependencies [e829db2]
  - @generacy-ai/config@0.3.0

## 0.7.0

### Minor Changes

- daed90b: feat: route gh-CLI GitHub API calls through the JIT token provider (#773)

  Completes the JIT credential migration: the gh-CLI GitHub API path no longer
  relies on the static wizard `GH_TOKEN`, which expired after ~1h and caused
  workers and the orchestrator to 401 mid-run. The orchestrator now mints
  short-lived installation tokens on demand via the JIT GitHub token provider
  (`jit-github-token-provider`), with the wizard-creds provider retained as a
  fallback, and the control-plane git-credential helper resolves tokens through
  the shared `jit-git-token-client`.

## 0.6.0

### Minor Changes

- 6b59696: feat: cluster-side JIT git credential helper (#766)

  Add a git `credential.helper` that fetches a fresh GitHub installation token on
  each git operation instead of caching the static `GH_TOKEN`. The control-plane
  gains a `git-token` route plus `git-token-manager`, `cloud-pull-client`, and
  `cluster-api-key` services that obtain a token on demand from the cloud pull
  endpoint (generacy-ai/generacy-cloud#817), cache it in-process, and refresh
  within ~5 min of expiry. A new `git-credential-generacy` bin speaks the git
  credential-helper protocol for `github.com` and degrades with a clear
  `CLOUD_UNREACHABLE` error rather than a silent hang.

- 474f3e3: feat(control-plane): package the worker→control-plane git-token proxy as a bin (#768)

  Ports the worker-side git-token proxy out of the cluster-base standalone script
  (`.devcontainer/generacy/scripts/git-token-proxy.js`) into
  `@generacy-ai/control-plane` as a typed, unit-tested bin shipped at
  `dist/bin/git-token-proxy.js`, co-located with the existing
  `git-credential-generacy` helper.

  Behavior is preserved exactly: env `GIT_TOKEN_PROXY_SOCKET` (default
  `/run/generacy-git-token/control.sock`) plus `CONTROL_PLANE_SOCKET_PATH`; a
  single `POST /git-token` route that 404s everything else; `502
CONTROL_SOCKET_UNREACHABLE` on upstream failure; listen-socket perms `0660`;
  stale-socket cleanup on boot; and `SIGTERM`/`SIGINT` graceful shutdown. Unit
  tests cover the single-route allow-list (security boundary), forwarding, and the
  unreachable-upstream error mapping.

## 0.5.0

### Minor Changes

- 3652b0d: feat(control-plane): drive GH_USERNAME/GH_EMAIL from the credential's acting account (#760)

  `mapCredentialToEnvEntries` now emits `GH_USERNAME`/`GH_EMAIL` from the
  github-app credential's new `gitIdentityLogin` field (the operator-selected
  acting account) when present, falling back to `accountLogin` for credentials
  sealed before the field existed. This fixes commit mis-attribution and silent
  label-monitor drops on org-owned repos, where `accountLogin` is the org name
  rather than a person, without requiring a `CLUSTER_GITHUB_USERNAME` override.

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
