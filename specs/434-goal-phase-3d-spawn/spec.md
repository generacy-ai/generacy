# Feature Specification: Migrate cli-spawner shell validators to AgentLauncher

**Branch**: `434-goal-phase-3d-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Route the two generic shell spawn sites in `cli-spawner.ts` (`runValidatePhase` and `runPreValidateInstall`) through `AgentLauncher` + `GenericSubprocessPlugin` using the `shell` intent kind. This is Phase 3d of the spawn refactor — these sites run arbitrary `sh -c <cmd>` snippets for validate and pre-validate phases, not Claude-specific.

## Context

Both spawn sites currently call `this.processFactory.spawn('sh', ['-c', command], ...)` directly. The `GenericSubprocessPlugin` already supports a `shell` intent kind that wraps a command in `sh -c`, producing the identical command line. AgentLauncher handles env merging (3-layer: `process.env` → plugin env → caller env), factory selection by stdio profile, and signal propagation.

### Current Spawn Sites

| Site | File:Line | Timeout | Env | Phase |
|------|-----------|---------|-----|-------|
| `runValidatePhase` | `cli-spawner.ts:102` | 10 min (600,000 ms) | `{}` (empty) | `'validate'` |
| `runPreValidateInstall` | `cli-spawner.ts:129` | 5 min (300,000 ms) | `{}` (empty) | `'validate'` |

Both pass `undefined` for OutputCapture (no output parsing needed) and delegate to `manageProcess()` for timeout, abort-signal, and exit-code handling.

## User Stories

### US1: Consistent spawn routing

**As a** platform engineer maintaining the orchestrator,
**I want** all shell spawn sites to route through AgentLauncher,
**So that** spawn behavior (env merging, process lifecycle, signal handling) is centralized and testable through a single path.

**Acceptance Criteria**:
- [ ] `runValidatePhase` delegates to `agentLauncher.launch()` with `intent: { kind: 'shell', command: validateCommand }`
- [ ] `runPreValidateInstall` delegates to `agentLauncher.launch()` with `intent: { kind: 'shell', command: installCommand }`
- [ ] Both produce `sh -c <cmd>` invocations byte-identical to the pre-refactor baseline

### US2: No behavioral regression

**As a** developer running validation workflows,
**I want** the migrated spawn paths to behave identically,
**So that** existing validate and pre-validate phases work unchanged.

**Acceptance Criteria**:
- [ ] Existing tests in `cli-spawner.test.ts` pass without modification
- [ ] Timeout values (10 min / 5 min) are preserved
- [ ] Abort-signal propagation continues to work
- [ ] Empty env override behavior is preserved (process.env from factory, no extra vars)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Accept `AgentLauncher` as a constructor dependency in `CliSpawner` | P1 | Follow same pattern as SubprocessAgency migration |
| FR-002 | Replace `processFactory.spawn('sh', ['-c', cmd])` in `runValidatePhase` with `agentLauncher.launch({ intent: { kind: 'shell', command: cmd }, cwd, ... })` | P1 | Use `handle.process` for `manageProcess()` |
| FR-003 | Replace `processFactory.spawn('sh', ['-c', cmd])` in `runPreValidateInstall` similarly | P1 | Same pattern as FR-002 |
| FR-004 | Env handling: pass empty `env: {}` in the launch request to preserve current behavior (no caller overrides) | P1 | AgentLauncher merges `process.env` as base layer; plugin `shell` kind provides no extra env |
| FR-005 | Wire `handle.process` into existing `manageProcess()` call unchanged | P1 | Timeout, abort, exit-code handling stays in `manageProcess()` |
| FR-006 | Add snapshot tests for composed `sh -c` commands | P1 | Byte-identical to pre-refactor baseline |

## Design Notes

### AgentLauncher Integration Pattern

Based on the SubprocessAgency migration (commit `033ddc5`), the pattern is:

```typescript
// In runValidatePhase:
const handle = this.agentLauncher.launch({
  intent: { kind: 'shell', command: validateCommand },
  cwd: checkoutPath,
});
const child = handle.process;
// rest of manageProcess() call unchanged
```

### Env Behavior

Current code passes `env: {} as Record<string, string>` to ProcessFactory. The default ProcessFactory merges this with `process.env`: `{ ...process.env, ...options.env }`. After migration, AgentLauncher will merge: `{ ...process.env, ...pluginEnv, ...requestEnv }`. Since `GenericSubprocessPlugin.buildLaunch()` for `shell` kind passes through `intent.env` (undefined/empty) and no request env is provided, the effective env is just `process.env` — identical behavior.

### What Stays Unchanged

- `manageProcess()` method — timeout, abort-signal, graceful kill, exit-code handling
- `PhaseResult` return type
- `OutputCapture` usage (none for these sites)
- Phase name assignments (`'validate'`)

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Snapshot test parity | 100% byte-identical `sh -c` commands | Snapshot comparison |
| SC-002 | Existing test pass rate | 100% | `pnpm test` in orchestrator package |
| SC-003 | No direct `processFactory.spawn` for shell sites | 0 remaining direct calls for validate/install | Code review |

## Assumptions

- `AgentLauncher` and `GenericSubprocessPlugin` are already implemented and tested (Wave 1 dependency).
- The `CliSpawner` constructor can be extended to accept an `AgentLauncher` parameter.
- The `manageProcess()` method works with any `ChildProcessHandle`, regardless of how it was spawned.

## Out of Scope

- Changes to validation logic itself.
- Claude-code spawn sites (separate Wave 3 issues).
- Changes to `manageProcess()` internals.
- Removing `processFactory` from `CliSpawner` (other spawn sites may still use it directly).

## Dependencies

- **Depends on**: Wave 1 Agent Launcher (`GenericSubprocessPlugin`) — #425
- **Does NOT depend on**: Wave 2 Claude Plugin issue
- **Parallel-safe with**: Other Wave 3 issues (#429, #430)
- **Parent tracking**: #423

## Key Files

| File | Role |
|------|------|
| `packages/orchestrator/src/worker/cli-spawner.ts` | Primary migration target (lines 89-135) |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | Launcher to route through |
| `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` | Plugin providing `shell` intent |
| `packages/orchestrator/src/launcher/types.ts` | `ShellIntent`, `LaunchRequest`, `LaunchHandle` |
| `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` | Existing tests (lines 307-413) |

---

*Generated by speckit*
