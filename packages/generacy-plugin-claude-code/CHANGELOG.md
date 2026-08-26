# @generacy-ai/generacy-plugin-claude-code

## 0.6.0

### Minor Changes

- c1154f5: Review phase executor — structured findings artifact + engine-internal verdict (#1124).

  Replaces the inert `runStubPhase('review')` (from #1121) with a real executor. The engine builds an in-process charter prompt (selected by `review.profile`), spawns the CLI via a new `review` launch intent, the agent writes a structured findings sidecar, and the engine Zod-validates the findings and **recomputes** the verdict (`clean` | `changes-required`) — the agent-claimed verdict is ignored and GitHub review state is never used (the cluster account 422s on `REQUEST_CHANGES` against its own PR). The next-phase decision is driven through the synchronous `remediateTrigger` seam, bounded by `maxRemediations` with a `waiting-for:remediation-limit` gate pause. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `waiting-for:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `review` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the review-artifact sidecar module, the review charter builder, the `ReviewExecutor`, the `on-remediation-limit` gate condition, and the phase-loop/worker wiring — internal plumbing with no new public exports.

- 1484e11: Remediate phase executor — remediation counter + remediation-limit gate (#1128).

  Replaces the inert `runStubPhase('remediate')` (from #1121) with a real `RemediateExecutor` that runs a single code-change pass over the open blocking findings recorded in the review sidecar, then backtracks to `review` for verification. The loop is bounded by an explicit, resettable `remediationCount` (distinct from the monotonic `round`) that is incremented by exactly one on every executor return path — normal exit, timeout kill, and spawn failure — so a perpetually-timing-out attempt still consumes budget. At the cap the `on-remediation-limit` gate pauses with `waiting-for:remediation-limit` + `agent:paused` and posts a gate-body comment; an operator adds `completed:remediation-limit` to reset the counter and re-arm the gate. No terminal `blocked:*` label is ever applied, and the executor never resolves review threads, marks the PR ready, writes GitHub review state, or touches `round`/`verdict`. Remains byte-identical when `reviewPhaseEnabled=false`.

  `@generacy-ai/workflow-engine` (minor) adds the `completed:remediation-limit` label vocabulary.

  `@generacy-ai/generacy-plugin-claude-code` (minor) adds the `remediate` launch intent kind.

  `@generacy-ai/orchestrator` (patch) adds the remediate charter builder, the `RemediateExecutor`, the `remediationCount` sidecar field and bump/reset helpers, and the phase-loop/worker wiring — internal plumbing with no new public exports.

### Patch Changes

- 6a5b1c3: Fix validate-origin remediation to consume the shared remediation budget and have a reliable stop. Both validate-origin and review-origin remediations now converge on the single `RemediateExecutor` (each dispatch bumps `remediationCount`), so the `on-remediation-limit` gate is reachable on the validate path. The validate failure fingerprint reason is now stable across test-output nondeterminism, and the executor reports a `timedOut` signal so partial work from a timeout-kill is committed while a clean-run non-zero exit leaves the branch untouched. When a clean-run non-zero exit skips the remediate commit, the working tree is now reverted (hard-reset + clean, preserving `.generacy/`) via the new `GitHubClient.discardWorkingTreeChanges()` method so the abandoned partial fix cannot be committed by the subsequent review phase. Retires the `ValidateFixHandler` adapter and the `validate-fix` launch intent.

## 0.5.0

### Minor Changes

- dcf915d: Cockpit auto model/effort configuration + effort on conversation launches.

  `@generacy-ai/cockpit`: `CockpitConfigSchema` gains an optional `auto` block
  (`cockpit.auto` in `.generacy/config.yaml`) for the `/cockpit:auto` run loop —
  `loop` (model/effort for the loop session, consumed by headless launchers),
  `heartbeatSeconds` (base heartbeat interval, 60–3600), `quiet` (suppress
  transcript narration for headless runs), and `agents` (per-role
  `{ provider?, model?, effort? }` selectors for the clarifier / reviewer /
  validator / fixer / diagnoser analysis subagents, mirroring the orchestrator's
  `AgentEntrySchema`). An invalid `auto` block degrades to a loader warning and
  is ignored, so it can never break `owner`/`assignee` consumers.

  `@generacy-ai/orchestrator` + `@generacy-ai/generacy-plugin-claude-code`:
  `ConversationTurnIntent` / `POST /conversations` gain an optional `effort`
  field, threaded through `ConversationManager`/`ConversationSpawner` to
  `claude --effort <level>` — the phase path already supported effort; the
  conversation path (used for headless slash-command launches like
  `/cockpit:auto`) now does too.

## 0.4.0

### Minor Changes

- 75ba0f7: Add optional per-phase `effort` alongside `model` on the `orchestrator.agents` block (#1095), and bring the two fixer paths that ignored agent config into parity with `pr-feedback-handler`.

  - `@generacy-ai/config`: new `EffortSchema` enum (`low | medium | high | xhigh | max`), new optional `effort` field on `AgentEntrySchema`, and `.strict()` on `AgentEntrySchema` / `WorkflowAgentEntriesSchema` (both levels) / `AgentsConfigSchema`. Typos inside `orchestrator.agents` (`defualt:`, `implment:`, `efort:`) now fail validation; typos outside the block continue to strip silently.
  - `@generacy-ai/generacy-plugin-claude-code`: new public static `ClaudeCodeLaunchPlugin.hasEffortMechanism()` — probes `claude --help` once per process (result cached) and reports whether `--effort` is a recognized flag, so a container whose CLI predates or removes `--effort` reports `false` and the drop warning fires instead of a silent unknown-option spawn failure. `--effort` is now appended by all four builders (`buildPhaseLaunch`, `buildPrFeedbackLaunch`, `buildValidateFixLaunch`, `buildMergeConflictLaunch`). `buildValidateFixLaunch` and `buildMergeConflictLaunch` also gain the `--model` push previously missing on those two paths.
  - `@generacy-ai/generacy`: new `loadConfigWithWarnings` helper + `warnings` field on `generacy validate --json` output. When `effort` is set but the resolved provider has no CLI mechanism for effort in this release, a warning naming both `effort` and the provider is surfaced on both the auto-discovery and explicit-path branches (exit code stays 0). New "Orchestrator Agent Selection" section in `docs/docs/getting-started/configuration.md` and an updated `packages/generacy/examples/config-full.yaml` demonstrate the block with `effort:`.
  - `@generacy-ai/orchestrator`: internal plumbing only — `mergeAgentEntry` and `resolveAgentForPhase` learn to walk `effort` as a fourth independent field; `CliSpawnOptions` + `PhaseIntent` / `PrFeedbackIntent` / `ValidateFixIntent` / `MergeConflictIntent` gain the field; `validate-fix-handler` and `merge-conflict-handler` now call `resolveAgentForPhase(config, workflowName, 'implement')` and forward `{ provider, model, effort }` to their intents and `LaunchRequest.provider`. `cli-spawner` and all three fixer handlers (`pr-feedback`, `validate-fix`, `merge-conflict`) emit one `agent.effort.dropped` warn line per spawn when `effort` cannot be delivered (extracted into shared `effort-mechanism-check.ts`). `MergeConflictMonitorService` now enqueues unlabeled paused issues with `workflowName: 'unknown'` (mirrors `pr-feedback-monitor-service.resolveWorkflowName`) so the handler-side Q1=B fallback is reachable in production.

  Behavior-preserving: any repo with no `agents` block, or with `agents` set but `effort` unset, produces byte-identical argv + env across all four spawn paths (SC-004).

## 0.3.0

### Minor Changes

- 5488c4c: Provider-neutral launch intents and a `(provider, kind)` plugin registry (#813).

  - `@generacy-ai/orchestrator`: the agent launch intent types (`phase`,
    `pr-feedback`, `validate-fix`, `merge-conflict`, `conversation-turn`,
    `invoke`) now live in and are owned by `src/launcher/types.ts` — the core
    `LaunchIntent` union no longer imports `ClaudeCodeIntent` from the Claude
    plugin, so the concrete provider no longer leaks into orchestrator core.
    `PhaseIntent`/`PrFeedbackIntent` gain an optional `model` field and
    `LaunchRequest` gains an optional `provider` selector (default
    `'claude-code'`). The launcher registry is re-keyed on `(provider, kind)`,
    keeping duplicate-registration protection per key, and an unknown provider
    produces a typed error. These types are also exposed via the new
    `@generacy-ai/orchestrator/launcher/types` subpath export.
  - `@generacy-ai/orchestrator-types`: `LaunchRequest` and `AgentLaunchPlugin`
    gain the `provider` field mirroring the orchestrator-owned contract.
  - `@generacy-ai/generacy-plugin-claude-code`: `ClaudeCodeLaunchPlugin` declares
    its `provider` namespace. The plugin structurally mirrors the
    orchestrator-owned intent types locally (same pattern as its local
    `LaunchSpec`/`OutputParser`) rather than importing them across the package
    boundary, so the two packages do not form a build-time cycle. No call-site
    behavior change — all sites resolve to the `claude-code` provider and argv
    output is byte-identical.

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

## 0.2.0

### Minor Changes

- f5b162a: Re-validate on base advance and add a bounded validate-fix cycle (#892).

  Two red classes were stranding issues at `failed:validate` with no recovery, so
  an auto run could never reach `epic-complete`:

  - **Stale integration reds (a).** A new base-advance monitor polls each PR's base
    branch head SHA on the existing ~60s cadence; when it advances (a sibling PR
    merges, an external PR merges, or a direct push lands), every open speckit
    issue sitting at `failed:validate` against that base is re-armed via `cockpit
resume`. Dependency-ordered merges unlock dependents one at a time with no
    membership machinery; `(issue, new base SHA)` is the natural re-arm key and the
    #879 in-flight dedupe collapses storms. `getRefHeadSha` is added to the
    workflow-engine GitHub client for the SHA poll.
  - **Genuine code reds (b).** A red that persists on a fresh merge-preview gets one
    autonomous `ValidateFixHandler` attempt on the branch — a new
    `ValidateFixIntent` in the claude-code plugin, sharing the PrFeedbackHandler
    spawn→commit→push→re-check plumbing with the #883 termination discipline (the
    attempt must change the tree or stop). Attempt identity is a SHA-256 evidence
    hash over the normalized failing-test/module set + first error line (ANSI,
    timestamps, absolute paths, and per-run identifiers stripped), so the same red
    never triggers a second autonomous attempt — further attempts only via the
    escalation gate. Still red after the attempt → `failed:validate` + alert.

- 186a92a: Add the bounded merge-conflict resolution handler #864 deferred (#898).

  `#864` shipped the pre-phase base-merge guardrail and the
  `waiting-for:merge-conflicts` pause but deferred the actual resolver to a
  follow-up that was never filed — so issues that paused at that gate could never
  transition. This ships both halves:

  - **Self-describing pause surface.** The merge-conflict pause comment now
    documents the manual escalation path (resolve on the branch, push, then
    advance) and stays load-bearing as the `blocked:stuck-merge-conflicts`
    escalation surface.
  - **Bounded autonomous resolver.** A merge-conflict monitor enqueues a resolution
    item for issues sitting at `waiting-for:merge-conflicts`, and a new
    `MergeConflictHandler` (shaped like `PrFeedbackHandler`, driven by a new
    claude-code `MergeConflictIntent`) makes exactly one autonomous CLI attempt on
    the branch with #883-style termination discipline: pre-agent git/network flakes
    get bounded 3× retries, the agent runs at most once, and `git push` retries only
    network errors — a non-fast-forward rejection escalates to
    `blocked:stuck-merge-conflicts` rather than looping. On success it applies
    `completed:merge-conflicts` and clears the pause; on failure it preserves the
    gate and emits an evidence block. Adds the `blocked:stuck-merge-conflicts` label
    to the workflow-engine vocabulary.

## 0.1.1

### Patch Changes

- 6779a85: Bulk patch bump to populate the `stable` npm dist-tag for the 14 packages that were left at 0.1.0 by the previous changeset cycle (which only listed `@generacy-ai/generacy` and `@generacy-ai/cluster-relay`).

  After this changeset is consumed by changesets/action and the resulting version-packages PR merges to main, all 16 public `@generacy-ai/*` packages in this repo will be on `stable` on npm.
