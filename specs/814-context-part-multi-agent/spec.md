# Feature Specification: Multi-agent phase 1b — agent provider/model config surface threaded to phase spawns

**Branch**: `814-context-part-multi-agent` | **Date**: 2026-07-13 | **Status**: Draft | **Issue**: [#814](https://github.com/generacy-ai/generacy/issues/814)

## Summary

Introduce an `orchestrator.agents` config block in `.generacy/config.yaml` and thread `{ provider, model }` selection from that config all the way to workflow phase spawns. Ships immediate user value on its own — per-phase **model** selection for Claude Code (e.g., Opus for `specify`, Sonnet for `implement`) — before any non-Claude provider exists. Part of the [multi-agent provider plan (Codex + OpenCode)](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md) — Phase 1, issue 2 of 3. Depends on #813.

## Context

Today, no provider or model can be configured for workflow phases. The only model field anywhere in the config tree is `conversations.defaultModel`, which controls interactive conversations only. Workflow phase spawns (`specify`, `plan`, `tasks`, `implement`, `validate`, plus `pr-feedback`) always use whatever Claude Code defaults to, with no way to override per-phase or per-workflow. This issue adds the config surface, the resolver, and the plumbing to `LaunchRequest`.

The `defaults.agent` field already exists in the CLI-facing config schema but is currently unconsumed — this issue wires it as the repo-level provider default.

## User Stories

### US1: Per-phase model selection for a workflow (Primary)

**As a** repo owner using the `speckit-feature` workflow,
**I want** to specify a different Claude model for each phase in `.generacy/config.yaml`,
**So that** I can use a stronger reasoning model for `specify`/`plan` and a cheaper/faster model for `implement`/`validate`.

**Acceptance Criteria**:
- [ ] A `.generacy/config.yaml` with `orchestrator.agents.workflows.speckit-feature.phases.specify.model: claude-opus-4-7` and `phases.implement.model: claude-sonnet-4-6` produces argv containing `--model claude-opus-4-7` on the `specify` spawn and `--model claude-sonnet-4-6` on the `implement` spawn.
- [ ] Config validation rejects malformed entries with a clear error before any phase runs.

### US2: Repo-level provider/model default

**As a** repo owner,
**I want** a single `orchestrator.agents.default: { provider, model }` entry to apply to every phase and every workflow,
**So that** I don't have to enumerate every phase when I want a uniform default.

**Acceptance Criteria**:
- [ ] `agents.default.model: claude-sonnet-4-6` with no per-workflow/per-phase entries produces `--model claude-sonnet-4-6` on every phase spawn.
- [ ] A per-phase override wins over `agents.default` (precedence tested end-to-end).

### US3: Cluster-wide default via env vars

**As a** platform operator running the cluster,
**I want** to set `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` env vars,
**So that** every repo without an explicit override uses my chosen defaults without editing per-repo config.

**Acceptance Criteria**:
- [ ] `WORKER_AGENT_MODEL=claude-opus-4-7` with no repo-side `agents` config produces `--model claude-opus-4-7` on every phase spawn.
- [ ] Any repo-side `agents.default` / workflow / phase entry wins over the env var.

### US4: Provider-aware resume drops session on switch

**As a** repo owner mixing providers across phases (once a non-Claude provider lands),
**I want** cross-phase session resume to drop the session when the resolved provider changes between phases,
**So that** we don't send a Claude session id to a Codex/OpenCode spawn (or vice versa).

**Acceptance Criteria**:
- [ ] When `phase N` resolves to provider A and `phase N+1` resolves to provider B, the phase loop drops the stored session id before invoking phase N+1's launcher.
- [ ] Same-provider transitions preserve the session id (existing resume behavior unchanged).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `OrchestratorSettingsSchema` (`packages/config/src/template-schema.ts`) with an `agents` block: `default` / `workflows.<name>.default` / `workflows.<name>.phases.<phase>`. Each entry is `{ provider?: string, model?: string }` with both fields optional. | P1 | Both fields optional so a caller can set only `model` and inherit the resolved `provider`. |
| FR-002 | Mirror the field in the CLI-facing schema (`packages/generacy/src/config/schema.ts`) and update `examples/config-*.yaml` with commented example entries. | P1 | |
| FR-003 | Wire the existing (currently unconsumed) `defaults.agent` field as the repo-level provider default. | P1 | Feeds into the precedence chain at the `defaults.agent` tier. |
| FR-004 | Extend `WorkerConfigSchema` (`packages/orchestrator/src/worker/config.ts`) with the merged `agents` block, modeled on `PhaseTimeoutOverridesSchema`. | P1 | Same merge/override shape as timeouts. |
| FR-005 | Extend the repo-override merge (today `applyRepoValidateOverrides`) so per-repo `.generacy/config.yaml` `agents` entries merge onto the cluster/env defaults. | P1 | |
| FR-006 | Add cluster-default env plumbing `WORKER_AGENT_PROVIDER` / `WORKER_AGENT_MODEL` in `config/loader.ts`. | P1 | |
| FR-007 | Add `resolveAgentForPhase(config, workflowName, phase)` (sibling of `resolvePhaseTimeoutMs`) that returns `{ provider, model }` implementing precedence: `phases.<phase>` > `workflows.<name>.default` > `agents.default` > repo `defaults.agent` > cluster default (env) > built-in `claude-code`. | P1 | |
| FR-008 | Provider and model resolve independently — a phase override that sets only `model` inherits `provider` from the next tier up, and vice versa. | P1 | Prevents "you must set both" cliff. |
| FR-009 | Thread `{ provider, model }` through `CliSpawnOptions` → intent → `LaunchRequest`. | P1 | |
| FR-010 | `ClaudeCodeLaunchPlugin` pushes `--model <model>` on `phase` and `pr-feedback` intents when `model` is set, mirroring the existing conversation-turn `--model` path. | P1 | |
| FR-011 | Provider-aware resume: thread `{ provider, sessionId }` in the phase loop; drop `sessionId` when the next phase resolves to a different provider. | P1 | Cross-phase context lives in the spec artifacts by design — no in-process context transfer needed. |
| FR-012 | Unknown provider at phase start fails the phase with a clear message through the existing stage-comment error path — no silent fallback to Claude. | P1 | |
| FR-013 | Ship parity for the no-config case: with no `orchestrator.agents` block anywhere and no env vars, every phase spawn resolves to the built-in `claude-code` provider with no `--model` argv addition (i.e., argv byte-identical to today). | P1 | Guarded by SC-003 snapshot. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Precedence-chain unit tests | All 6 tiers pass (phase > workflow.default > agents.default > defaults.agent > env > built-in), for both `provider` and `model` independently | Unit tests in `resolveAgentForPhase` test file |
| SC-002 | Argv snapshot shows per-phase `--model` from fixture config | Snapshot matches expected argv with `--model <phase-specific-model>` for each phase | Snapshot test using a fixture `.generacy/config.yaml` |
| SC-003 | No-config parity snapshot | Snapshot argv unchanged vs. pre-#814 for a config with no `agents` block and no env vars set | Snapshot test |
| SC-004 | Provider-switch resume drop test | With a two-phase run resolving to different providers, the second phase spawn receives no `sessionId` even when one is stored | Unit test using the fake plugin from #813 |
| SC-005 | Schema-error copy | Invalid `agents` YAML (e.g., non-string `model`) produces a Zod validation error before any spawn runs | Config-load unit test |

## Assumptions

- The `defaults.agent` field in the current CLI schema is safe to repurpose as the repo-level provider default (no existing consumers rely on it being unconsumed).
- Provider plugin abstraction from #813 is available and provides a way to identify a provider by string name for resolution/switch detection.
- Cross-phase context does not need to be transferred programmatically across a provider switch — spec artifacts (spec.md, plan.md, tasks.md) are the durable handoff, so dropping `sessionId` on a switch is sufficient.
- Existing `PhaseTimeoutOverridesSchema` is a good structural template for the `agents` merge/override shape.
- The `--model` argv flag on Claude Code accepts full model IDs (e.g., `claude-opus-4-7`, `claude-sonnet-4-6`) exactly as documented — no translation layer needed.

## Out of Scope

- Adding any new provider plugin (Codex, OpenCode). That is Phase 1 issue 3 of the multi-agent plan and depends on this issue landing first.
- Runtime-observable per-phase metrics or telemetry on which provider/model was selected. Argv logging via existing spawn-log paths is sufficient for now.
- UI (cloud/dashboard) surface for editing `orchestrator.agents` — YAML-only in this issue.
- Per-conversation model override (conversations already have `conversations.defaultModel`; no change here).
- Model migration/rewriting when a stored session id encodes a specific model. Provider-level switch detection is the only cross-phase invariant we enforce.

## References

- Issue: https://github.com/generacy-ai/generacy/issues/814
- Depends on: #813 (Phase 1 issue 1 — provider plugin abstraction + fake plugin for tests)
- Followed by: Phase 1 issue 3 — first non-Claude provider (Codex or OpenCode) using this config surface
- Multi-agent provider plan: https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md

---

*Generated by speckit*
