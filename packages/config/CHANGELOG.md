# @generacy-ai/config

## 0.6.0

### Minor Changes

- 8c925b4: Add `review` and `remediate` to the workflow phase machinery (#1121).

  Widens the canonical `WorkflowPhase` vocabulary with two new phases and threads them through every hand-maintained duplication site so the packages compile and existing runs stay byte-identical. This ships type/config/label plumbing plus inert stub execution only — real executors, prompts, verdict/finding logic, and concrete `remediate` triggers land in later epic issues.

  `@generacy-ai/workflow-engine` (minor) adds the `phase:`/`completed:`/`failed:`/`failed:*-repeated` label families for both `review` and `remediate` to `WORKFLOW_LABELS` (no `waiting-for:` gate labels) and widens the `CorePhase` union.

  `@generacy-ai/config` (minor) widens the public `template-schema` `phases` keys to accept optional `review` / `remediate` agent entries.

  `@generacy-ai/orchestrator` (patch) inserts `review` into `PHASE_SEQUENCE` between `implement` and `validate` (feature/bugfix inherit it; `speckit-epic` unchanged), maps both new phases to the `implementation` stage, adds a `reviewPhaseEnabled` flag (default `false`) that skips `review` before any label side effect fires, adds an inert stub executor for both phases, and adds an off-sequence `remediate` seam gated on an injectable `remediateTrigger` (undefined in production → dead by default).

  `@generacy-ai/generacy` (patch) adds `review` / `remediate` to the cockpit `resume` `KNOWN_PHASES` list.

- cf38f6b: Add per-workflow orchestrator overrides to `.generacy/config.yaml` (#1122).

  `@generacy-ai/config` gains a new `orchestrator.workflows.<name>` map so a target repo can vary `validateCommand`, `preValidateCommand`, `maxRemediations`, and a `review` block per workflow (e.g. `speckit-feature` vs `speckit-bugfix`). New public schema/type exports: `WorkflowReviewSchema`, `WorkflowOverrideSchema`, `WorkflowReview`, `WorkflowOverride`. Value schemas are `.strict()` so unknown keys fail loudly.

  `@generacy-ai/orchestrator` gains an internal `resolveWorkflowOverrides` resolver (plus `DEFAULT_REVIEW` and `ResolvedWorkflowConfig`) that walks each field independently with `??` — precedence workflow-level > repo-level > cluster default for validate commands, and workflow-level > built-in default for `maxRemediations`/`review` (no repo tier). No consumer wiring yet; the review/remediate phases consume it under epic #1120.

- a1099e3: Wire four silently-dropped per-workflow/agent config keys so they take effect at runtime (#1160).

  Four config keys shipped by the engine-native review/remediate epic parsed cleanly (or were documented) but were ignored at their runtime call sites:

  - `validateCommand` — the non-bugfix validate seed now resolves through `resolveWorkflowOverrides` so a per-workflow `workflows.<name>.validateCommand` reaches the validate spawn. `speckit-bugfix` keeps its targeted-validate narrowing composed over the resolved base.
  - `preValidateCommand` — the pre-validate install step now reads the resolved value; an explicit `""` at the workflow tier skips the install, while an unset tier falls through to the repo/cluster default.
  - `phases.review` / `phases.remediate` agent selection — the review and remediate executors now resolve the agent via a new field-by-field `resolveReviewLikeAgent`, preferring the phase tier and falling back to the full `implement` resolution per field. Remediate never inherits the `review` tier.
  - `ciWaitTimeoutMs` — added as an optional per-workflow override on the public `WorkflowOverride` schema (bounded `>= 30_000`, mirroring the cluster floor) and wired into the CI-readiness wait.

  `@generacy-ai/config` bumps **minor** (additive optional `ciWaitTimeoutMs` on the public `WorkflowOverride` type — new user-facing config surface). `@generacy-ai/orchestrator` bumps **patch** (internal call-site wiring plus the new non-exported `resolveReviewLikeAgent`; no public export change).

## 0.5.0

### Minor Changes

- 5df2231: Remove the hardcoded `develop` workspace branch so `generacy setup workspace` no longer force-switches every repo. `convertTemplateConfig` now passes a new optional top-level template `branch:` key through verbatim instead of always emitting `branch: 'develop'`, and `WorkspaceConfigSchema.branch` becomes `z.string().min(1).optional()` with no default — `undefined` is a representable "no preference" (FR-001 / FR-002).

  The `setup workspace` resolution chain (`--branch` > `REPO_BRANCH` > `DEFAULT_BRANCH` > config branch) loses its terminal `?? 'develop'` fallback (FR-007). When no tier supplies a branch, setup never switches an existing checkout: it fetches and pulls the current branch, and leaves detached HEADs or branches with no matching `origin/<b>` fetched-but-untouched while still reporting success. New repos clone without `--branch`. The `Configuration` log line reports the resolved `branchSource` and renders the no-preference case as `(repo default / current branch)` (FR-006).

  Explicit-branch behavior is unchanged. Fixes #1088.

- 75ba0f7: Add optional per-phase `effort` alongside `model` on the `orchestrator.agents` block (#1095), and bring the two fixer paths that ignored agent config into parity with `pr-feedback-handler`.

  - `@generacy-ai/config`: new `EffortSchema` enum (`low | medium | high | xhigh | max`), new optional `effort` field on `AgentEntrySchema`, and `.strict()` on `AgentEntrySchema` / `WorkflowAgentEntriesSchema` (both levels) / `AgentsConfigSchema`. Typos inside `orchestrator.agents` (`defualt:`, `implment:`, `efort:`) now fail validation; typos outside the block continue to strip silently.
  - `@generacy-ai/generacy-plugin-claude-code`: new public static `ClaudeCodeLaunchPlugin.hasEffortMechanism()` — probes `claude --help` once per process (result cached) and reports whether `--effort` is a recognized flag, so a container whose CLI predates or removes `--effort` reports `false` and the drop warning fires instead of a silent unknown-option spawn failure. `--effort` is now appended by all four builders (`buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`). `buildValidateFixLaunch` and `buildMergeConflictLaunch` also gain the `--model` push previously missing on those two paths.
  - `@generacy-ai/generacy`: new `loadConfigWithWarnings` helper + `warnings` field on `generacy validate --json` output. When `effort` is set but the resolved provider has no CLI mechanism for effort in this release, a warning naming both `effort` and the provider is surfaced on both the auto-discovery and explicit-path branches (exit code stays 0). New "Orchestrator Agent Selection" section in `docs/docs/getting-started/configuration.md` and an updated `packages/generacy/examples/config-full.yaml` demonstrate the block with `effort:`.
  - `@generacy-ai/orchestrator`: internal plumbing only — `mergeAgentEntry` and `resolveAgentForPhase` learn to walk `effort` as a fourth independent field; `CliSpawnOptions` + `PhaseIntent` / `PrFeedbackIntent` / `ValidateFixIntent` / `MergeConflictIntent` gain the field; `validate-fix-handler` and `merge-conflict-handler` now call `resolveAgentForPhase(config, workflowName, 'implement')` and forward `{ provider, model, effort }` to their intents and `LaunchRequest.provider`. `cli-spawner` and all three fixer handlers (`pr-feedback`, `validate-fix`, `merge-conflict`) emit one `agent.effort.dropped` warn line per spawn when `effort` cannot be delivered (extracted into shared `effort-mechanism-check.ts`). `MergeConflictMonitorService` now enqueues unlabeled paused issues with `workflowName: 'unknown'` (mirrors `pr-feedback-monitor-service.resolveWorkflowName`) so the handler-side Q1=B fallback is reachable in production.

  Behavior-preserving: any repo with no `agents` block, or with `agents` set but `effort` unset, produces byte-identical argv + env across all four spawn paths (SC-004).

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
