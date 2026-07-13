# Feature Specification: Multi-agent phase 1a — provider-neutral launch intents and (provider, kind) plugin registry

**Branch**: `813-context-part-multi-agent` | **Date**: 2026-07-13 | **Status**: Draft
**Issue**: [#813](https://github.com/generacy-ai/generacy/issues/813)

## Summary

Enable the orchestrator's `AgentLauncher` to host multiple agent provider plugins side-by-side. Today the launcher dispatches by `intent.kind` alone and `ClaudeCodeLaunchPlugin` owns every agent kind exclusively; a second provider cannot register. This change re-keys the plugin registry on `(provider, kind)`, moves the agent-intent types into orchestrator core so the Claude plugin no longer leaks into `launcher/types.ts`, and threads an optional `provider` field through `LaunchRequest` (default `'claude-code'`). Behavior is unchanged when no provider is specified.

## Context

Part of the [multi-agent provider plan (Codex + OpenCode)](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/multi-agent-provider-plan.md) — Phase 1, issue 1 of 3.

Current constraints:
- `AgentLauncher.registerPlugin` throws on duplicate `intent.kind` (`packages/orchestrator/src/launcher/agent-launcher.ts:34-44`), preventing any second agent plugin for the `phase`, `pr-feedback`, `conversation-turn`, or `invoke` kinds.
- The orchestrator core intent union imports `ClaudeCodeIntent` from the Claude plugin (`packages/orchestrator/src/launcher/types.ts:2,33`), leaking a concrete provider into orchestrator core.
- No call site can express which provider should handle a launch.

This issue makes the launcher capable of hosting multiple agent plugins with zero behavior change. Config surface, the output-parser seam, and any new provider plugin come in later phases.

## Scope

- Move agent intent types (`phase`, `pr-feedback`, `conversation-turn`, `invoke`) into `packages/orchestrator/src/launcher/types.ts`, owned by the orchestrator.
- Add optional `model` field to the `phase` and `pr-feedback` intents.
- Add optional `provider` field to `LaunchRequest` (default `'claude-code'`).
- Re-key the plugin registry on `(provider, kind)`; preserve duplicate-registration protection per `(provider, kind)` key.
- Remove the `ClaudeCodeIntent` import from `launcher/types.ts`; `generacy-plugin-claude-code` imports (or structurally matches) the orchestrator-owned intent types.
- No call-site behavior change: all sites omit `provider` and resolve to `'claude-code'`.

## User Stories

### US1: Register a second agent provider plugin

**As a** platform engineer wiring up a new agent backend (Codex, OpenCode),
**I want** to register a plugin for the `phase` (or any agent) kind under a distinct provider key,
**So that** both plugins can coexist and the orchestrator can dispatch to the right one by `(provider, kind)`.

**Acceptance Criteria**:
- [ ] `AgentLauncher.registerPlugin` accepts a second plugin claiming `kind: 'phase'` when the `provider` differs from an already-registered plugin.
- [ ] Registering two plugins with the same `(provider, kind)` still throws with a clear duplicate-registration error.
- [ ] A test registers a fake second plugin for the `phase` kind under provider `test-agent` and dispatches to it by `provider`.

### US2: Preserve existing Claude-Code behavior

**As a** developer operating the orchestrator today,
**I want** existing launches (which never pass `provider`) to keep dispatching to `claude-code` unchanged,
**So that** this refactor ships zero-behavior-change and doesn't require call-site edits.

**Acceptance Criteria**:
- [ ] `LaunchRequest.provider` defaults to `'claude-code'` when omitted.
- [ ] All existing call sites continue to work without modification.
- [ ] Existing argv snapshot tests pass byte-identical (no-config parity).

### US3: Clean orchestrator/plugin boundary

**As a** maintainer of the orchestrator core,
**I want** `launcher/types.ts` to own agent intent types instead of importing them from a concrete plugin package,
**So that** the plugin boundary is not leaky and adding future providers doesn't require touching orchestrator core imports.

**Acceptance Criteria**:
- [ ] `packages/orchestrator/src/launcher/types.ts` no longer imports `ClaudeCodeIntent` from `generacy-plugin-claude-code`.
- [ ] `generacy-plugin-claude-code` imports the intent types from orchestrator (or matches them structurally).
- [ ] Launching with an unknown provider produces a typed error.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Move `PhaseIntent`, `PrFeedbackIntent`, `ConversationTurnIntent`, and `InvokeIntent` type definitions into `packages/orchestrator/src/launcher/types.ts`. | P1 | Orchestrator owns the shape. |
| FR-002 | Add optional `model?: string` field to `PhaseIntent` and `PrFeedbackIntent`. | P1 | Consumed later; introduced here for stability of the type surface. |
| FR-003 | Add optional `provider?: string` field to `LaunchRequest`, defaulting to `'claude-code'`. | P1 | Default applied inside `AgentLauncher.launch` if omitted. |
| FR-004 | Re-key the plugin registry from `Map<kind, Plugin>` to `Map<`(provider, kind)`, Plugin>` (or equivalent). | P1 | Registration + lookup both key on the tuple. |
| FR-005 | `registerPlugin` throws on duplicate `(provider, kind)` registration, retaining today's error semantics. | P1 | Same protection, wider key. |
| FR-006 | `launch()` dispatches by `(request.provider ?? 'claude-code', intent.kind)`. | P1 | |
| FR-007 | `launch()` throws a typed error (e.g., `UnknownProviderError` or existing typed error class) when no plugin matches the `(provider, kind)` pair. | P1 | Distinguishable from generic errors in tests. |
| FR-008 | Remove `import { ClaudeCodeIntent } from 'generacy-plugin-claude-code'` from `packages/orchestrator/src/launcher/types.ts`. | P1 | Break the leak. |
| FR-009 | Update `generacy-plugin-claude-code` to consume the orchestrator-owned intent types (import or structural). | P1 | Package must still build. |
| FR-010 | All existing launcher call sites continue to work without passing `provider`. | P1 | Zero call-site changes required for parity. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | argv snapshot parity | 100% pass byte-identical | Run existing argv snapshot tests; diff = 0. |
| SC-002 | Second-provider dispatch | Passes | New test: fake `test-agent` plugin for `phase` kind is dispatched to when `provider: 'test-agent'` is supplied. |
| SC-003 | Unknown-provider error | Typed error thrown | New test: `launch({ provider: 'nope', … })` throws a typed error (not a generic `Error`). |
| SC-004 | No orchestrator→plugin type imports | 0 references | grep `packages/orchestrator/src/launcher/` for imports of `generacy-plugin-claude-code` intent types → 0 matches. |
| SC-005 | No call-site edits | 0 non-test call sites changed | git diff of `packages/orchestrator/src/` excluding `launcher/` + tests shows no dispatch-site changes. |

## Assumptions

- The default provider identifier is the literal string `'claude-code'`. If a shared constant already exists, this spec adopts it.
- `ClaudeCodeLaunchPlugin` registers with `provider: 'claude-code'` (either explicitly or via a default in its own registration path).
- No consumer today depends on the pre-refactor exception thrown for duplicate-kind registration; the new duplicate-key error is acceptable in its place.
- The typed error class for unknown providers is either an existing launcher error (extended) or a new class in `packages/orchestrator/src/launcher/`. Naming and location are an implementation detail decided in `/plan`.
- The optional `model` field on phase/pr-feedback intents is accepted but unused in this phase; consumers land in a later phase.

## Out of Scope

- Config surface for selecting providers (Phase 1, issue 2 of 3).
- The output-parser seam ("Wave 3" — plan Phase 2).
- Any new provider plugin implementation (plan Phase 3 — Codex, OpenCode).
- Behavior changes at existing call sites.
- Runtime effects of the new `model` field on the phase / pr-feedback intents.

---

*Generated by speckit*
