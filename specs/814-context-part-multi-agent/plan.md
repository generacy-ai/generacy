# Implementation Plan: Multi-Agent Provider — Phase 1, Issue 2 (Config Surface + Per-Phase Model Threading)

**Feature**: Add the `orchestrator.agents` config block and thread `{ provider, model }` from the target repo's `.generacy/config.yaml` through worker config, resolver, spawn options, intent, and launch request into `ClaudeCodeLaunchPlugin`'s `--model` argv. Ships immediate value on its own: per-phase **model** selection for Claude Code, before any second provider exists.
**Branch**: `814-context-part-multi-agent`
**Status**: Complete

## Summary

`#813` widened the launcher so it can dispatch to `(provider, kind)` tuples and added `provider?: string` to `LaunchRequest` + `model?: string` to `PhaseIntent`/`PrFeedbackIntent`. Every call site still omits both — the fields are wired end-to-end but nothing sources them.

This change:
1. Extends `OrchestratorSettingsSchema` (`packages/config/src/template-schema.ts`) with an `agents` block — `default`, `workflows.<name>.default`, `workflows.<name>.phases.<phase>` — each entry `{ provider?, model? }`. Workflow phase keys are a **closed set** over the `WorkflowPhase` enum (Q5→A).
2. Mirrors the same block in the CLI-facing schema (`packages/generacy/src/config/schema.ts`) and updates `examples/config-full.yaml`.
3. Extends `WorkerConfigSchema` (`packages/orchestrator/src/worker/config.ts`) with the merged `agents` block, structurally modelled on `PhaseTimeoutOverridesSchema`. Extends `applyRepoValidateOverrides` (or introduces a sibling merge) so the target repo's `.generacy/config.yaml` `agents` block overlays the cluster default.
4. Adds cluster-default env plumbing `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` in `packages/orchestrator/src/config/loader.ts`. Independent resolution at the env tier (Q3→A).
5. Wires the existing (currently unconsumed) `defaults.agent` as the repo-level provider default in the resolver chain.
6. Adds `resolveAgentForPhase(config, workflowName, phase)` in `packages/orchestrator/src/worker/config.ts` (sibling of `resolvePhaseTimeoutMs`) implementing precedence: `phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo `defaults.agent` > cluster default (env) > built-in `claude-code`. Provider and model resolve **independently** — a phase override may set only `model`.
7. Threads `{ provider, model }` through `CliSpawnOptions` → phase-loop → `PhaseIntent`/`PrFeedbackIntent` → `LaunchRequest.provider`.
8. `ClaudeCodeLaunchPlugin.buildPhaseLaunch` / `buildPrFeedbackLaunch` push `--model <id>` when `intent.model` is set (mirrors the existing `buildConversationTurnLaunch` path).
9. **Provider-aware resume in the phase loop**: track the resolved provider alongside `currentSessionId`. When the next phase resolves to a different provider, drop the stored `sessionId`. When only the **model** changes (provider unchanged), preserve `sessionId` and emit `agent.model.transition prev=<m> next=<m>` in the spawn log (Q2→C).
10. **pr-feedback resolution**: `PrFeedbackHandler` resolves `{ provider, model }` by binding to the `implement` phase — call `resolveAgentForPhase(config, workflowName, 'implement')` at the pr-feedback spawn site (Q1→B). No pseudo-phase in the schema.
11. **Unknown provider at phase start**: the existing `UnknownProviderError` from `AgentLauncher.launch()` surfaces via the phase-loop's `spawn-error` catch → `stage-comment` error path. Message text unchanged (from #813). No silent fallback to Claude.

**No behavior change when unconfigured**: every argv snapshot remains byte-identical when `agents` is absent from all tiers. `--model` only appears when someone explicitly configures it.

## Technical Context

- **Language**: TypeScript (ESM, Node ≥22)
- **Packages touched**:
  - `packages/config/src/template-schema.ts` — `OrchestratorSettingsSchema.agents` (source of truth on target repos)
  - `packages/generacy/src/config/schema.ts` — CLI-facing mirror + type export
  - `packages/generacy/examples/config-full.yaml` — documented example only (minimal + single-repo remain unchanged)
  - `packages/orchestrator/src/worker/config.ts` — `WorkerConfigSchema.agents`, merge helper (`applyRepoAgentOverrides` sibling of `applyRepoValidateOverrides`), `resolveAgentForPhase()`
  - `packages/orchestrator/src/config/loader.ts` — `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` env vars
  - `packages/orchestrator/src/worker/types.ts` — `CliSpawnOptions` gains `provider?: string; model?: string`
  - `packages/orchestrator/src/worker/cli-spawner.ts` — reads options.provider/model, threads to `LaunchRequest.provider` and `PhaseIntent.model`; emits `agent.model.transition` log line when caller signals a same-provider model change
  - `packages/orchestrator/src/worker/phase-loop.ts` — tracks `currentProvider` alongside `currentSessionId`, calls `resolveAgentForPhase`, drops session on provider switch, threads model to spawner
  - `packages/orchestrator/src/worker/pr-feedback-handler.ts` — resolves `{ provider, model }` for the `implement` phase, threads to `LaunchRequest.provider` + `PrFeedbackIntent.model`
  - `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — `--model` push on `phase` + `pr-feedback` when `intent.model` present
- **Dependencies**: no new runtime deps. Vitest for tests.
- **Resolver signature**: `resolveAgentForPhase(config: WorkerConfig, workflowName: string, phase: WorkflowPhase): { provider: string; model?: string }`. Provider always defined (built-in fallback). Model optional (there is no built-in default).
- **Schema shape** (see `data-model.md` §1): `agents.default: { provider?, model? } | undefined`, `agents.workflows: Record<string, { default?, phases? }>`. `phases` is closed over the `WorkflowPhase` enum, defined per-field like `PhaseTimeoutOverridesSchema` so partial overrides don't drop sibling defaults.

## Project Structure

```
packages/config/src/
└── template-schema.ts                    # MODIFIED — OrchestratorSettingsSchema.agents (source of truth for target repos)

packages/generacy/src/config/
└── schema.ts                             # MODIFIED — mirror agents block on the CLI-facing schema; export AgentsConfig type

packages/generacy/examples/
└── config-full.yaml                      # MODIFIED — document agents block usage (minimal/single-repo untouched)

packages/orchestrator/src/config/
└── loader.ts                             # MODIFIED — WORKER_AGENT_PROVIDER / WORKER_AGENT_MODEL env plumbing

packages/orchestrator/src/worker/
├── config.ts                             # MODIFIED — AgentsConfigSchema, WorkerConfigSchema.agents,
│                                         #   resolveAgentForPhase(), applyRepoAgentOverrides()
├── types.ts                              # MODIFIED — CliSpawnOptions.provider?, CliSpawnOptions.model?
├── cli-spawner.ts                        # MODIFIED — thread provider/model to LaunchRequest + PhaseIntent;
│                                         #   emit `agent.model.transition` log line on model-only change
├── phase-loop.ts                         # MODIFIED — currentProvider tracking, resolveAgentForPhase per phase,
│                                         #   drop currentSessionId on provider switch
├── pr-feedback-handler.ts                # MODIFIED — resolveAgentForPhase(config, workflowName, 'implement')
│                                         #   at spawn site (Q1→B)
└── __tests__/
    ├── resolve-agent-for-phase.test.ts   # NEW — precedence chain unit tests
    ├── phase-loop-provider-switch.test.ts# NEW — session-drop-on-provider-switch + preserve-on-model-change
    └── cli-spawner-model-argv.test.ts    # NEW/MODIFIED — --model argv snapshot per phase from fixture config

packages/generacy-plugin-claude-code/src/launch/
├── claude-code-launch-plugin.ts          # MODIFIED — buildPhaseLaunch / buildPrFeedbackLaunch push --model
└── __tests__/
    └── claude-code-launch-plugin.test.ts # MODIFIED — snapshots for phase + pr-feedback with model=…
```

## Constitution Check

No `.specify/memory/constitution.md` present in the repo. Skipped.

## Non-Goals (repeated for emphasis)

- Any concrete second provider (Codex/OpenCode) — Phase 3.
- Custom-workflow phase names in `agents.workflows.<name>.phases` — closed to `WorkflowPhase` enum (Q5→A). Widening is non-breaking; narrowing isn't.
- Model-ID allowlist or format validation beyond `z.string().min(1)` — opaque pass-through (Q4→A).
- A dedicated `agents.prFeedback` slot — deferred; `implement` binding is the absent-case fallback (Q1→B).
- Dropping the session on same-provider **model** changes — preserved by design (Q2→C). Log line only.
- Config-schema changes to `packages/orchestrator-types` — this issue's schema surface is `packages/config` (target-repo source of truth) and `packages/generacy` (CLI mirror); `orchestrator-types` intentionally stays subset-by-design (see #813 D-8).

## Acceptance Gate (from spec)

- [ ] Unit tests cover the precedence chain (`phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo `defaults.agent` > env > built-in), including independent provider/model resolution at each tier.
- [ ] Argv snapshots show `--model` per phase from a fixture config wired through the phase loop.
- [ ] No-config parity snapshot unchanged (byte-identical when `agents` is absent everywhere).
- [ ] Provider-switch unit test (fake plugin registered under provider `test-agent`) proves the phase loop drops the session on provider transition; same-provider **model** change preserves the session and emits the `agent.model.transition` log line.
- [ ] Unknown provider at phase start fails through the `spawn-error` catch → stage-comment error path with `UnknownProviderError`'s existing message text — no silent fallback.
- [ ] pr-feedback spawn resolves `{ provider, model }` against the `implement` phase (Q1→B) — verified via a unit test that fixture-configures `phases.implement.model` and asserts the pr-feedback argv snapshot picks it up.

## Next Step

Run `/speckit:tasks` to generate the ordered, parallelizable task list from this plan.
