# Feature Specification: Migrate executeCommand / executeShellCommand to AgentLauncher

**Branch**: `430-goal-phase-4b-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Route `executeCommand` and `executeShellCommand` in `packages/workflow-engine/src/actions/cli-utils.ts` through `AgentLauncher` + `GenericSubprocessPlugin` instead of calling `child_process.spawn` directly. These functions are public API on `@generacy-ai/workflow-engine`, so their signatures and behavior must remain byte-identical.

This is Phase 4b of the [spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-4--migrate-generic-subprocess-paths), part of Wave 2.

## User Stories

### US1: Internal developer maintaining spawn infrastructure

**As a** platform engineer,
**I want** all subprocess spawning to go through `AgentLauncher`,
**So that** there is a single, auditable code path for process lifecycle management across the entire system.

**Acceptance Criteria**:
- [ ] `executeCommand` delegates to `agentLauncher.launch()` with `kind: 'generic-subprocess'`
- [ ] `executeShellCommand` delegates to `agentLauncher.launch()` with `kind: 'shell'`
- [ ] No direct `child_process.spawn` calls remain in `cli-utils.ts`

### US2: Downstream consumer of workflow-engine public API

**As a** developer consuming `@generacy-ai/workflow-engine`,
**I want** the refactor to be invisible to me,
**So that** my existing code continues to work without any changes.

**Acceptance Criteria**:
- [ ] `CommandOptions` and `CommandResult` interfaces unchanged (exported from `index.ts:58-63`)
- [ ] Function signatures of `executeCommand(command, args, options)` and `executeShellCommand(command, options)` unchanged
- [ ] Timeout, abort-signal, and streaming callback behavior identical

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `executeCommand` must use `agentLauncher.launch({ intent: { kind: 'generic-subprocess', command, args }, cwd, env, signal })` | P1 | Maps directly to existing `GenericSubprocessIntent` |
| FR-002 | `executeShellCommand` must use `agentLauncher.launch({ intent: { kind: 'shell', command }, cwd, env, signal })` | P1 | Maps directly to existing `ShellIntent` |
| FR-003 | Preserve `detached: true` process-group semantics | P1 | Load-bearing: `process.kill(-pid, 'SIGTERM')` kills entire tree. Must be handled in ProcessFactory or spawn options. |
| FR-004 | Preserve `onStdout`/`onStderr` streaming callbacks | P1 | Wire through `LaunchHandle.process` stdout/stderr streams or `OutputParser.processChunk` |
| FR-005 | Preserve timeout behavior (kill process group after N ms, exit code 124) | P1 | Currently managed in-function; may stay as wrapper logic around `LaunchHandle` |
| FR-006 | Preserve abort-signal propagation (kill process group on signal abort) | P1 | `LaunchRequest.signal` already supports this — verify ProcessFactory propagates it |
| FR-007 | Preserve early-abort check (`signal?.aborted` → exit code 130) | P2 | Guard before calling `launch()` |
| FR-008 | Preserve `StringDecoder` UTF-8 chunk boundary handling in `executeCommand` | P2 | Currently only in `executeCommand`, not `executeShellCommand` |
| FR-009 | `CommandOptions` and `CommandResult` types must not change | P1 | Public API contract |

## Key Technical Considerations

### AgentLauncher integration from workflow-engine

`AgentLauncher` lives in `packages/orchestrator`. The `cli-utils.ts` functions live in `packages/workflow-engine`. The migration must resolve this cross-package dependency. Options:

1. **Dependency injection**: Accept an `AgentLauncher` instance (or a launch function) as an optional parameter, falling back to direct spawn for backward compatibility.
2. **Re-export or shared package**: Extract launcher types to a shared package.
3. **Interface adapter**: Define a minimal `ProcessLauncher` interface in workflow-engine that AgentLauncher satisfies.

### Process-group kill semantics

The `detached: true` + `process.kill(-pid, 'SIGTERM')` pattern is critical. The current `ProcessFactory` in orchestrator must support `detached: true` spawn options, or the migration must ensure this behavior is preserved at the factory level. This is the highest-risk area of the migration.

### Timeout and lifecycle management

`AgentLauncher.launch()` returns a `LaunchHandle` synchronously. Timeout and abort-signal handling currently live inside the `executeCommand`/`executeShellCommand` Promise wrappers. These wrappers will need to:
1. Call `agentLauncher.launch()` to get the handle
2. Wire up timeout timer → `handle.process.kill()` (process group)
3. Wire up abort signal → `handle.process.kill()` (process group)
4. Collect stdout/stderr via handle streams
5. Await `handle.process.exitPromise`
6. Return `CommandResult`

## Acceptance Criteria

- [ ] Public signatures of `executeCommand` and `executeShellCommand` unchanged
- [ ] `CommandOptions` and `CommandResult` types unchanged
- [ ] Snapshot tests for composed spawn calls for both functions, matching pre-refactor baseline
- [ ] Existing timeout and abort-signal tests still pass — process-group kill semantics preserved
- [ ] All existing workflow-engine tests pass unchanged
- [ ] No direct `child_process.spawn` calls remain in `executeCommand` or `executeShellCommand`

## Out of Scope

- Migrating `SubprocessAgency` (separate Wave 2 issue, Phase 4a)
- Any changes to workflow action implementations that call these utilities
- Migrating `checkCLI` / `checkAllCLIs` (uses `execFile`, not `spawn`)
- Changes to the `GenericSubprocessPlugin` or `AgentLauncher` APIs themselves

## Dependencies

- **Depends on**: Wave 1 Agent Launcher (`AgentLauncher` + `GenericSubprocessPlugin` already landed in #441, #442)
- **Parallel-safe with**: Other Wave 2 issues
- **Parent tracking**: #423

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Public API compatibility | 100% | No changes to exported types or function signatures |
| SC-002 | Test pass rate | 100% | All existing workflow-engine tests pass |
| SC-003 | Direct spawn elimination | 0 calls | No `child_process.spawn` in `executeCommand`/`executeShellCommand` |
| SC-004 | Snapshot coverage | 2 snapshots | One per function, matching pre-refactor baseline |

## Assumptions

- `AgentLauncher` and `GenericSubprocessPlugin` are stable and available (Wave 1 complete)
- The `ProcessFactory` can support `detached: true` semantics (or will be extended)
- Cross-package dependency between workflow-engine and orchestrator is acceptable or will be resolved via dependency injection

---

*Generated by speckit*
