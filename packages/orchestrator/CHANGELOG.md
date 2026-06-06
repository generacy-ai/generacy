# Changelog

## 0.5.0

### Minor Changes

- daed90b: feat: route gh-CLI GitHub API calls through the JIT token provider (#773)

  Completes the JIT credential migration: the gh-CLI GitHub API path no longer
  relies on the static wizard `GH_TOKEN`, which expired after ~1h and caused
  workers and the orchestrator to 401 mid-run. The orchestrator now mints
  short-lived installation tokens on demand via the JIT GitHub token provider
  (`jit-github-token-provider`), with the wizard-creds provider retained as a
  fallback, and the control-plane git-credential helper resolves tokens through
  the shared `jit-git-token-client`.

### Patch Changes

- Updated dependencies [daed90b]
  - @generacy-ai/control-plane@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [6b59696]
- Updated dependencies [474f3e3]
  - @generacy-ai/control-plane@0.6.0

## 0.4.0

### Minor Changes

- 223d320: feat: cluster-side backstop for expired/near-expiry GH_TOKEN (#762)

  Detect an expired or near-expiry GitHub token and request a refresh instead of
  silently 401-looping. `workflow-engine` now surfaces `GhAuthError` and
  `parseGhStatusCode` so callers can distinguish auth failures, and the
  `orchestrator` adds a credential-expiry watcher plus GitHub auth-health state
  (exposed on the health route) so the label and PR-feedback monitors drive a
  credential-refresh request rather than repeatedly failing on 401s.

### Patch Changes

- Updated dependencies [3652b0d]
- Updated dependencies [223d320]
  - @generacy-ai/control-plane@0.5.0
  - @generacy-ai/workflow-engine@0.2.0

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

- dc03887: feat(orchestrator): detect cluster identity split and emit relay event (#750)

  Adds an identity-split detector that compares `process.env.GENERACY_CLUSTER_ID`
  against the persisted `cluster.json.cluster_id` during server startup. On
  mismatch it emits a single `cluster.identity-split` relay event per orchestrator
  process lifetime — surfacing clusters whose injected env identity has diverged
  from their persisted identity.

  The detector is best-effort and non-fatal: it never mutates env, `.env`, or
  `cluster.json`, and drops the event if no relay client is available. The new
  `cluster.identity-split` channel is added to the internal relay-events allowlist,
  and detection runs on both the existing-key and wizard-mode activation paths.

### Patch Changes

- cca7963: fix(orchestrator): fall back to GH_USERNAME for cluster identity (assignee filtering)

  The label-monitor resolves the cluster's GitHub identity to filter issues by
  assignee. It checked `CLUSTER_GITHUB_USERNAME`, then `gh api /user`, then gave
  up ("filtering disabled, all issues processed"). On cloud/wizard clusters the
  credential is a GitHub App installation token (`<app>[bot]`), which can't call
  `/user`, so identity resolution failed and the cluster processed every issue
  instead of only those assigned to the selected account.

  `resolveClusterIdentity` now falls back to `GH_USERNAME` — the human account
  the installation belongs to, already delivered to the cluster by the wizard —
  between the explicit config var and the `gh api /user` attempt. `CLUSTER_GITHUB_USERNAME`
  still takes precedence.

- Updated dependencies [6f74140]
- Updated dependencies [967718e]
- Updated dependencies [30ce711]
  - @generacy-ai/control-plane@0.4.0
  - @generacy-ai/cluster-relay@0.3.0

## 0.2.1

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
  - @generacy-ai/control-plane@0.3.0
  - @generacy-ai/activation-client@0.2.0
  - @generacy-ai/config@0.2.0
  - @generacy-ai/cluster-relay@0.2.0

## 0.1.3

### Patch Changes

- d0cdf36: Force a republish of `@generacy-ai/orchestrator` after the release workflow was fixed to actually rewrite `workspace:` dependencies. The previous publish (0.1.2) shipped with `workspace:^` literals in `dependencies` because `pnpm changeset publish` internally shells out to `npm publish`, which doesn't understand the workspace protocol. The fixed workflow uses `pnpm -r publish` (matching what `publish-preview.yml` already does) so the rewrite happens at pack time. This release retires the broken 0.1.2.

## 0.1.2

### Patch Changes

- 8b1a12d: Fix workspace:^ dependency leak in published package. Add prepublishOnly guardrail to all publishable packages to prevent future publishes with unresolved workspace: protocol specifiers.
- Updated dependencies [95f3c52]
  - @generacy-ai/control-plane@0.2.0

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.

- Updated dependencies [6779a85]
  - @generacy-ai/activation-client@0.1.1
  - @generacy-ai/config@0.1.1
  - @generacy-ai/control-plane@0.1.1
  - @generacy-ai/credhelper@0.1.1
  - @generacy-ai/generacy-plugin-claude-code@0.1.1
  - @generacy-ai/workflow-engine@0.1.1

All notable changes to the `@generacy-ai/orchestrator` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Automatic PR ready-for-review marking: When the orchestrator workflow completes successfully (all phases done), the draft PR is now automatically marked as ready for review. This eliminates the need for manual intervention and ensures reviewers are notified immediately upon completion.
  - Added `PrManager.markReadyForReview()` method to convert draft PRs to ready state
  - Integrated with workflow completion flow in `claude-cli-worker.ts`
  - Idempotent operation: safely handles non-draft PRs without errors

### Changed

- Updated workflow completion behavior to transition PRs from draft to ready state automatically

## [0.1.0] - Initial Release

### Added

- Initial release of the orchestrator package
- Multi-phase workflow execution: specify → clarify → plan → tasks → implement → validate
- GitHub integration with draft PR creation and management
- Label-based workflow state tracking
- SSE-based progress reporting
