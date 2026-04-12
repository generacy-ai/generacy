# Feature Specification: Introduce AgentLauncher + GenericSubprocessPlugin

Phase 1 of the spawn refactor — new launcher layer with zero caller migrations.

**Branch**: `425-goal-phase-1-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Introduce `AgentLauncher` as a plugin-based abstraction layer over `ProcessFactory.spawn()` inside `@generacy-ai/orchestrator`. This is Phase 1 (Wave 1) of the [spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-1--introduce-agentlauncher-as-a-pass-through): ship the registry, types, and `GenericSubprocessPlugin` as new additive code with zero modifications to existing callers. Later waves will migrate callers and add specialized plugins (e.g. `ClaudeCodeLaunchPlugin`).

## Goal

Create the foundational launcher abstraction that decouples *what* a caller wants to run (`LaunchIntent`) from *how* it gets spawned (plugin-specific `buildLaunch()`), while preserving the existing `ProcessFactory` as the underlying spawn primitive. This enables future plugins to encapsulate command construction, env setup, and output parsing per agent type.

## Scope

- Create `AgentLauncher` inside `@generacy-ai/orchestrator` (internal module, **not** re-exported from `packages/orchestrator/src/index.ts`).
- Define types per the [plan Target design section](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#target-design): `LaunchRequest`, `LaunchHandle`, `LaunchIntent` (discriminated union with `phase`, `pr-feedback`, `conversation-turn`, `generic-subprocess`, `shell`), `LaunchSpec`, `AgentLaunchPlugin`, `OutputParser`.
- Implement `AgentLauncher.launch(request)`:
  - Resolves plugin from a `Map<pluginId, AgentLaunchPlugin>` registry
  - Delegates command/args/env construction to the plugin's `buildLaunch()`
  - Merges plugin env with caller env (caller wins for overrides)
  - Spawns via existing `ProcessFactory.spawn()` primitive
  - Returns a `LaunchHandle` wrapping the `ChildProcessHandle` with plugin-aware output parser
- Ship `GenericSubprocessPlugin` in the same change (orchestrator-local), handling `kind: "generic-subprocess"` and `kind: "shell"` intents as the escape hatch / pass-through.
- Register `GenericSubprocessPlugin` with the launcher at orchestrator boot (explicit registration, no dynamic discovery).

## User Stories

### US1: Internal developer adds a new agent type

**As an** orchestrator developer,
**I want** a plugin-based launcher registry that separates launch intent from spawn mechanics,
**So that** I can add new agent types (e.g. `ClaudeCodeLaunchPlugin`) without modifying existing spawn call sites.

**Acceptance Criteria**:
- [ ] `AgentLauncher` resolves the correct plugin by `pluginId` and delegates `buildLaunch()`
- [ ] Unknown `pluginId` throws a descriptive error
- [ ] Plugin env is merged with caller env (caller wins on conflict)

### US2: Existing callers remain unaffected

**As an** orchestrator maintainer,
**I want** the new launcher layer to be purely additive,
**So that** all existing tests and callers continue to work without modification.

**Acceptance Criteria**:
- [ ] Zero changes to existing files outside the new module
- [ ] All existing orchestrator, generacy, and workflow-engine tests pass unchanged
- [ ] `AgentLauncher` is not exported from `packages/orchestrator/src/index.ts`

### US3: Generic subprocess pass-through

**As a** caller that spawns arbitrary commands,
**I want** a `GenericSubprocessPlugin` that handles `generic-subprocess` and `shell` intents,
**So that** existing spawn patterns have a migration path through the new launcher.

**Acceptance Criteria**:
- [ ] `GenericSubprocessPlugin.buildLaunch()` produces correct `LaunchSpec` for `generic-subprocess` intent
- [ ] `GenericSubprocessPlugin.buildLaunch()` produces correct `LaunchSpec` for `shell` intent
- [ ] Signal propagation works through the `LaunchHandle` to the underlying process

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Define `LaunchIntent` as a discriminated union with kinds: `phase`, `pr-feedback`, `conversation-turn`, `generic-subprocess`, `shell` | P1 | Only `generic-subprocess` and `shell` are handled in this phase |
| FR-002 | Define `LaunchRequest` containing `LaunchIntent`, caller env overrides, cwd, and abort signal | P1 | |
| FR-003 | Define `LaunchSpec` as the output of `buildLaunch()`: command, args, env, stdio config | P1 | |
| FR-004 | Define `AgentLaunchPlugin` interface with `pluginId`, `supportedIntents`, `buildLaunch()` | P1 | |
| FR-005 | Define `OutputParser` interface for plugin-aware stream parsing | P1 | GenericSubprocessPlugin uses identity/passthrough parser |
| FR-006 | Define `LaunchHandle` wrapping `ChildProcessHandle` with `outputParser` and plugin metadata | P1 | |
| FR-007 | Implement `AgentLauncher` with `Map<pluginId, AgentLaunchPlugin>` registry and `launch()` method | P1 | |
| FR-008 | `AgentLauncher.launch()` merges plugin env with caller env; caller wins on key conflicts | P1 | |
| FR-009 | `AgentLauncher.launch()` delegates to `ProcessFactory.spawn()` for actual process creation | P1 | Reuse existing primitive |
| FR-010 | Implement `GenericSubprocessPlugin` handling `generic-subprocess` and `shell` intents | P1 | Pass-through: command/args come directly from the intent |
| FR-011 | Register `GenericSubprocessPlugin` at orchestrator boot via explicit call | P2 | No dynamic plugin discovery |
| FR-012 | `AgentLauncher` throws descriptive error for unknown `pluginId` | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Existing test suites | 100% pass, zero modifications | CI pipeline — orchestrator, generacy, workflow-engine test suites |
| SC-002 | New unit test coverage | Registry lookup, unknown plugin error, env merge precedence, ProcessFactory invocation, signal propagation | Unit test suite for `AgentLauncher` |
| SC-003 | Snapshot coverage | `GenericSubprocessPlugin.buildLaunch()` for both intent kinds | Snapshot tests |
| SC-004 | Public API surface | `AgentLauncher` NOT in `packages/orchestrator/src/index.ts` exports | Manual + grep verification |

## Assumptions

- Wave 0 (`ProcessFactory` interface extraction) has landed and the `ProcessFactory` / `ChildProcessHandle` interfaces are stable.
- The `ProcessFactory` interface at `packages/orchestrator/src/worker/types.ts:269` will not change during this work.
- Plugin registration is synchronous and happens at orchestrator boot before any `launch()` calls.
- No dynamic plugin discovery or lazy-loading is needed for Phase 1.

## Out of Scope

- Caller migrations (Waves 2–4) — no existing spawn call sites are changed.
- `ClaudeCodeLaunchPlugin` (Wave 2).
- Credentials / uid / gid plumbing (covered by Wave 1 ProcessFactory issue and follow-on credentials plan).
- Dynamic plugin discovery or plugin hot-reloading.
- Re-exporting `AgentLauncher` from the orchestrator package public API.

## Dependencies

- **Depends on**: Wave 0 landing (ProcessFactory interface extraction).
- **Blocks**: Wave 2 (ClaudeCodeLaunchPlugin, subprocess, cli-utils migrations) and Wave 3 (shell validators).
- **Parent tracking**: [#423](https://github.com/generacy-ai/generacy/issues/423)

## References

- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md)
- Current `ProcessFactory` interface: [packages/orchestrator/src/worker/types.ts:269](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/types.ts#L269)
- Existing `ProcessFactory` implementations: [claude-cli-worker.ts:25](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/claude-cli-worker.ts#L25), [process-factory.ts:10](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/process-factory.ts#L10)

---

*Generated by speckit*
