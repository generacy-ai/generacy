# @generacy-ai/config

## 0.4.0

### Minor Changes

- 92ca0b4: Agent provider/model config surface threaded to phase spawns (#814).

  Adds an `orchestrator.agents` config block so a repo's `.generacy/config.yaml`
  can select the agent `{ provider, model }` per workflow phase. Ships immediate
  value: per-phase **model** selection for Claude Code, ahead of any new provider.

  - `@generacy-ai/config`: `OrchestratorSettingsSchema` gains an `agents` block
    (`default` / `workflows.<name>.default` / `workflows.<name>.phases.<phase>`,
    each `{ provider?, model? }`).
  - `@generacy-ai/generacy`: mirrors the `agents` block in the CLI-facing config
    schema and `examples/config-*.yaml`, and wires the previously-unconsumed
    `defaults.agent` as the repo-level provider default.
  - `@generacy-ai/orchestrator`: `WorkerConfigSchema` carries the merged `agents`
    block; the repo-override merge and cluster-default env plumbing
    (`WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL`) are extended. New
    `resolveAgentForPhase(config, workflowName, phase)` implements precedence
    (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo
    `defaults.agent` > cluster default > built-in `claude-code`), resolving
    provider and model independently. `{ provider, model }` is threaded through
    `CliSpawnOptions` → intent → `LaunchRequest`; provider-aware resume drops the
    session when the next phase resolves to a different provider, and an unknown
    provider fails the phase with a clear message (no silent Claude fallback).
  - `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` pushes
    `--model` on `phase`/`pr-feedback` intents when set, mirroring the existing
    conversation-turn path. No-config argv output is unchanged.

## 0.3.0

### Minor Changes

- e829db2: feat(orchestrator): per-repo validate command overrides via .generacy/config.yaml

  The validate-phase commands (`validateCommand` / `preValidateCommand`) were
  orchestrator-global and monorepo-shaped (`pnpm test && pnpm build`). A single
  orchestrator serves many repos, so a single-package repo with a different shape
  (e.g. an Astro site with no `test` script) failed validate on every issue —
  `pnpm test` exits non-zero before the build runs.

  The target repo's `.generacy/config.yaml` `orchestrator` block can now set
  `validateCommand` / `preValidateCommand`, which are merged onto the global
  worker config per-job before the phase loop runs.

  - `@generacy-ai/config`: `OrchestratorSettingsSchema` gains optional
    `validateCommand` / `preValidateCommand`.
  - `@generacy-ai/orchestrator`: new pure helper `applyRepoValidateOverrides`
    (preserves an explicit empty `preValidateCommand` = skip install); the worker
    loads the repo's orchestrator settings at the existing per-job config hook and
    passes the merged config to the phase loop. Backward-compatible — repos
    without the block keep the global defaults.

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
