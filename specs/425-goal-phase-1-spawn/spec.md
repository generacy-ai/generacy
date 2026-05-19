# Feature Specification: Introduce AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Branch**: `425-goal-phase-1-spawn` | **Issue**: #425 | **Date**: 2026-04-12 | **Status**: Clarified

## Summary

Introduce the `AgentLauncher` abstraction layer inside `@generacy-ai/orchestrator` as new, additive code with zero caller migrations. This establishes the plugin registry, core type definitions, and a `GenericSubprocessPlugin` pass-through that later waves will build upon to consolidate all process spawning behind a unified interface.

## Goal

Phase 1 of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-1--introduce-agentlauncher-as-a-pass-through). Introduce the `AgentLauncher` layer as new code with zero caller migrations. Establishes the registry, types, and `GenericSubprocessPlugin` that later waves plug into.

## Scope

- Create `AgentLauncher` inside `@generacy-ai/orchestrator` (internal module, not re-exported from `packages/orchestrator/src/index.ts`).
- Define types per the [plan Target design section](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#target-design): `LaunchRequest`, `LaunchHandle`, `LaunchIntent` (discriminated union — Phase 1 defines `generic-subprocess` and `shell` only; remaining kinds added in their respective waves), `LaunchSpec`, `AgentLaunchPlugin`, `OutputParser`.
- Implement `AgentLauncher.launch(request)`:
  - Resolves plugin from a `Map<pluginId, AgentLaunchPlugin>` registry
  - Delegates command/args/env construction to the plugin's `buildLaunch()`
  - Merges env: `process.env` ← plugin env ← caller env (caller wins for overrides)
  - Selects `ProcessFactory` by `LaunchSpec.stdioProfile` (map of profile name → factory instance)
  - Spawns via selected `ProcessFactory.spawn()` primitive
  - Returns a thin `LaunchHandle` wrapping the `ChildProcessHandle` with plugin-aware output parser (no lifecycle ownership)
- Ship `GenericSubprocessPlugin` in the same change (orchestrator-local), handling `kind: "generic-subprocess"` and `kind: "shell"` intents as the escape hatch / pass-through.
- Register `GenericSubprocessPlugin` with the launcher at orchestrator boot (explicit registration, no dynamic discovery).

## Acceptance criteria

- No existing caller modified; all existing orchestrator/generacy/workflow-engine tests pass unchanged.
- New unit tests: registry lookup, unknown pluginId error, env merge precedence, ProcessFactory invocation, signal propagation.
- Snapshot tests for `GenericSubprocessPlugin.buildLaunch()` for both intents.
- `AgentLauncher` is NOT re-exported from `packages/orchestrator/src/index.ts` (resolved open question #1).

## Out of scope

- Caller migrations (Waves 2-4).
- `ClaudeCodeLaunchPlugin` (Wave 2).
- Credentials / uid / gid plumbing (covered by Wave 1 ProcessFactory issue and follow-on credentials plan).

## Dependencies

- Depends on Wave 0 landing.
- Blocks Wave 2 (ClaudeCodeLaunchPlugin, subprocess, cli-utils migrations) and Wave 3 (shell validators).

## References

- Parent tracking: #423
- Current `ProcessFactory` interface: [packages/orchestrator/src/worker/types.ts:269](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/types.ts#L269)
- Existing `ProcessFactory` implementations: [claude-cli-worker.ts:25](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/worker/claude-cli-worker.ts#L25), [process-factory.ts:10](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/conversation/process-factory.ts#L10)


## User Stories

### US1: Plugin-based process launching

**As an** orchestrator developer,
**I want** a centralized `AgentLauncher` that dispatches process launches through registered plugins,
**So that** new launch strategies (Claude Code, shell validators, etc.) can be added in later waves without modifying existing callers.

**Acceptance Criteria**:
- [ ] `AgentLauncher` accepts a `LaunchRequest` and resolves the correct plugin from its registry
- [ ] Plugin's `buildLaunch()` output is used to construct the spawn call
- [ ] A `LaunchHandle` is returned wrapping the child process with a plugin-aware output parser

### US2: Generic subprocess pass-through

**As an** orchestrator developer,
**I want** a `GenericSubprocessPlugin` that handles `generic-subprocess` and `shell` intents as a transparent pass-through,
**So that** the launcher can be exercised end-to-end in Phase 1 without migrating any existing callers.

**Acceptance Criteria**:
- [ ] `GenericSubprocessPlugin` is registered at orchestrator boot
- [ ] It handles `kind: "generic-subprocess"` and `kind: "shell"` intents
- [ ] It passes through command, args, and env without transformation

### US3: Signal propagation through LaunchHandle

**As an** orchestrator developer,
**I want** abort signals to propagate from `LaunchRequest` through to the spawned child process,
**So that** callers can cancel launched processes using standard `AbortSignal` patterns.

**Acceptance Criteria**:
- [ ] `LaunchRequest` accepts an optional `AbortSignal`
- [ ] Signal abort triggers process termination via the underlying `ChildProcessHandle`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Define `LaunchIntent` as a discriminated union type with `kind` field — only `generic-subprocess` and `shell` in Phase 1; remaining kinds added in their respective waves | P1 | Union is naturally additive in TypeScript |
| FR-002 | Define `LaunchRequest` type containing intent, caller env overrides, and optional abort signal | P1 | |
| FR-003 | Define `LaunchSpec` type as plugin output (command, args, env, `stdioProfile?: string` defaulting to `"default"`) | P1 | Launcher selects `ProcessFactory` by stdio profile |
| FR-004 | Define `AgentLaunchPlugin` interface with `pluginId`, `buildLaunch(intent)`, and `createOutputParser()` | P1 | |
| FR-005 | Define `OutputParser` interface: `processChunk(stream: 'stdout'\|'stderr', data: string): void` + `flush(): void` | P1 | Stateful processor, aligns with existing `OutputCapture` / `ConversationOutputParser` |
| FR-006 | Define `LaunchHandle` as thin wrapper exposing `process: ChildProcessHandle` (with `kill()`, `exitPromise`), `outputParser`, and metadata — no lifecycle ownership | P1 | Lifecycle consolidation deferred to Wave 3 |
| FR-007 | Implement `AgentLauncher` with `Map<pluginId, AgentLaunchPlugin>` registry and `launch(request)` method | P1 | |
| FR-008 | Env merge: `process.env` ← plugin env ← caller env (caller wins). Factories updated to NOT merge `process.env` | P1 | Factory change lands in same PR |
| FR-009 | Spawn via existing `ProcessFactory.spawn()` — no new spawn primitives | P1 | |
| FR-010 | Implement `GenericSubprocessPlugin` for `generic-subprocess` and `shell` intents | P1 | |
| FR-011 | Register `GenericSubprocessPlugin` at orchestrator boot (explicit, not dynamic) | P1 | |
| FR-012 | `AgentLauncher` must NOT be re-exported from `packages/orchestrator/src/index.ts` | P1 | Internal module only |
| FR-013 | Throw descriptive error on unknown `pluginId` lookup | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero caller changes | 0 existing callers modified | `git diff develop -- packages/orchestrator/src/worker/ packages/orchestrator/src/conversation/` shows no changes to existing spawn callers |
| SC-002 | Existing tests pass | 100% pass rate | All existing orchestrator, generacy, and workflow-engine tests pass unchanged |
| SC-003 | New unit test coverage | Registry lookup, unknown pluginId error, env merge precedence, ProcessFactory invocation, signal propagation | New test file(s) with passing assertions for each scenario |
| SC-004 | Snapshot tests for GenericSubprocessPlugin | `buildLaunch()` snapshots for both `generic-subprocess` and `shell` intents | Vitest snapshot tests |
| SC-005 | Internal-only export | `AgentLauncher` not in public API | `packages/orchestrator/src/index.ts` does not export launcher module |

## Assumptions

- Wave 0 (`ProcessFactory` extraction) has landed on `develop` and its types are available.
- `ProcessFactory.spawn()` interface remains stable during Phase 1 implementation.
- Explicit plugin registration (no dynamic discovery or plugin scanning) is sufficient for all planned waves.

## Out of Scope

- Caller migrations (Waves 2-4) — no existing code changes to use `AgentLauncher`.
- `ClaudeCodeLaunchPlugin` (Wave 2).
- Credentials / uid / gid plumbing (separate Wave 1 ProcessFactory issue).
- Dynamic plugin discovery or configuration-driven registration.

---

*Generated by speckit*
