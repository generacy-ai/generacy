# Feature Specification: ## Context

Part of the [multi-agent provider plan (Codex + OpenCode)](https://github

**Branch**: `813-context-part-multi-agent` | **Date**: 2026-07-13 | **Status**: Draft

## Summary

## Context

Part of the [multi-agent provider plan (Codex + OpenCode)](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md) — Phase 1, issue 1 of 3.

The `AgentLauncher` dispatches plugins by `intent.kind` alone, and `ClaudeCodeLaunchPlugin` exclusively owns the `phase`, `pr-feedback`, `conversation-turn`, and `invoke` kinds — `registerPlugin` throws on duplicate kinds (`packages/orchestrator/src/launcher/agent-launcher.ts:34-44`), so a second agent plugin cannot register for those kinds, and no call site can express a provider. The orchestrator's core intent union also imports `ClaudeCodeIntent` from the Claude plugin (`packages/orchestrator/src/launcher/types.ts:2,33`), leaking the concrete provider into orchestrator core.

This issue makes the launcher capable of hosting multiple agent plugins, with zero behavior change.

## Scope

- Move **all six** agent intent types — `phase`, `pr-feedback`, `conversation-turn`, `invoke`, `validate-fix` (#892), `merge-conflict` (#898) — into `packages/orchestrator/src/launcher/types.ts`, owned by the orchestrator. Add optional `model` to the phase and pr-feedback intents, and an optional `provider?: string` field to `LaunchRequest` (default `'claude-code'`).
- Re-key the plugin registry on `(provider, kind)` uniformly for **all** plugins. `GenericSubprocessPlugin` registers under a reserved `'system'` provider constant that is internal to the launcher (not exported, not accepted in workflow config).
- `AgentLaunchPlugin` gains a `readonly provider: string` field; plugins self-declare their provider. Registration signature stays `registerPlugin(plugin)` — no call-site churn.
- `LaunchRequest.provider` typed as bare `string` (no literal union, no branded type). Runtime unknown-provider protection is the designed guard.
- Both `DuplicatePluginRegistrationError` and the unknown-provider error are typed classes in `packages/orchestrator/src/launcher/`, distinguishable via `instanceof`.
- Remove the `ClaudeCodeIntent` import from `launcher/types.ts`; `generacy-plugin-claude-code` imports (or structurally matches) the orchestrator-owned intent types instead.
- No call-site behavior change: all sites omit `provider` and resolve to `claude-code`.

## Acceptance criteria

- [X] Existing argv snapshot tests pass byte-identical (no-config parity).
- [X] A test registers a fake second plugin for the `phase` kind under provider `test-agent` and dispatches to it by `provider`.
- [X] Launching with an unknown provider produces a typed error (`instanceof UnknownProviderError`).
- [X] Registering two plugins under the same `(provider, kind)` throws `DuplicatePluginRegistrationError` (typed).
- [X] `packages/orchestrator/src/launcher/types.ts` has no import from `generacy-plugin-claude-code`.

## Clarifications

### Session 1 — 2026-07-13

- Q: Do `validate-fix` and `merge-conflict` intents also move to orchestrator core alongside the four intents FR-001 names? → A: **Yes — all six move.** Orchestrator core owns the whole agent-intent surface; leaving two behind keeps a `ClaudeCodeIntent` import alive or forces a follow-up that re-churns the same file.
- Q: Does the `(provider, kind)` registry key apply to all plugins, or only agent-intent plugins? → A: **All plugins tuple-keyed.** `GenericSubprocessPlugin` registers under a reserved `'system'` constant, kept internal to the launcher (not exported, not valid in workflow config). One uniform registry keeps duplicate-protection and unknown-provider errors as a single code path.
- Q: How does the launcher discover the provider a plugin claims? → A: **`readonly provider: string` on `AgentLaunchPlugin`.** Plugin self-declares; registration signature stays `registerPlugin(plugin)`. Zero call-site churn (SC-005).
- Q: What TypeScript type should `LaunchRequest.provider` have? → A: **bare `string`.** Core must not enumerate concrete providers — the registry is the source of truth. Real values arrive at runtime from config; FR-007's typed unknown-provider error is the designed guard.
- Q: Should duplicate-registration also throw a typed error class? → A: **Yes — introduce `DuplicatePluginRegistrationError`.** Symmetric typed errors make bootstrap double-registration distinguishable via `instanceof` in tests and logs.

## Out of scope

Config surface (Phase 1 issue 2 — #814), the output-parser seam ("Wave 3" — plan Phase 2), and any new provider plugin (plan Phase 3).


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
