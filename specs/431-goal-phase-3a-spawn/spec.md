# Feature Specification: Phase 3a — Migrate cli-spawner.spawnPhase to AgentLauncher

**Branch**: `431-goal-phase-3a-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Flip the orchestrator's primary phase-loop spawn in `CliSpawner.spawnPhase()` from a hardcoded `ProcessFactory.spawn("claude", args, ...)` call to `AgentLauncher.launch()` with the `ClaudeCodeLaunchPlugin`. This is Phase 3a of the spawn refactor — the first orchestrator spawn site to migrate to the plugin-based launcher architecture established in Waves 1 and 2.

## Context

The spawn refactor consolidates all agent-process spawning behind a plugin-based `AgentLauncher`. Waves 1–2 delivered the launcher infrastructure (`AgentLauncher`, `ClaudeCodeLaunchPlugin`, snapshot harness). Wave 3 migrates each orchestrator spawn site one at a time. This issue covers the highest-traffic site: the phase-loop spawn in `cli-spawner.ts`.

**Current flow** (`cli-spawner.ts:75`):
1. `spawnPhase()` manually builds a Claude CLI args array (`-p`, `--output-format stream-json`, `--dangerously-skip-permissions`, `--verbose`, optional `--resume`)
2. Calls `this.processFactory.spawn("claude", args, { cwd, env })`
3. Delegates lifecycle to `manageProcess()` (timeout, abort signal, stdout/stderr capture)

**Target flow**:
1. `spawnPhase()` constructs a `LaunchRequest` with `PhaseIntent`
2. Calls `this.agentLauncher.launch(request)` — plugin handles arg building
3. Lifecycle management via `manageProcess()` remains unchanged

## User Stories

### US1: Transparent migration for orchestrator operators

**As an** orchestrator operator,
**I want** the phase-loop spawn to use `AgentLauncher` under the hood,
**So that** the spawn infrastructure is unified without any change to observable behavior (args, env, exit codes, output).

**Acceptance Criteria**:
- [ ] Snapshot test on the composed spawn is byte-identical to the pre-refactor snapshot from the Wave 1 harness
- [ ] All existing `cli-spawner` unit tests pass without modification
- [ ] Phase sequencing, session resume, abort-signal handling, and env inheritance behave identically

### US2: Consistent dependency injection for maintainers

**As a** codebase maintainer,
**I want** `AgentLauncher` injected into `CliSpawner` following the same pattern as `ProcessFactory`,
**So that** future spawn-site migrations (3b, 3c, 3d) follow a proven template.

**Acceptance Criteria**:
- [ ] `AgentLauncher` is a constructor parameter of `CliSpawner`
- [ ] Tests can inject a mock/recording `AgentLauncher` just as they inject mock `ProcessFactory` today
- [ ] The injection pattern is consistent with how `ClaudeCliWorker` already creates `AgentLauncher`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace `processFactory.spawn("claude", args, ...)` in `spawnPhase()` with `agentLauncher.launch({ intent: { kind: "phase", phase, prompt, sessionId }, cwd, env, signal })` | P1 | Core migration |
| FR-002 | Accept `AgentLauncher` as a constructor parameter in `CliSpawner`, alongside existing `ProcessFactory` and `Logger` | P1 | `ProcessFactory` is still needed for non-phase spawns (validate, pre-validate) |
| FR-003 | Extract `LaunchHandle.process` from the launch result and pass to existing `manageProcess()` logic unchanged | P1 | Preserves timeout, abort, stdout/stderr capture |
| FR-004 | Map `resumeSessionId` to `PhaseIntent.sessionId` so `ClaudeCodeLaunchPlugin` emits `--resume` flag correctly | P1 | Behavioral parity |
| FR-005 | Pass caller `env` via `LaunchRequest.env` so it merges at highest priority in the 3-layer merge | P1 | AgentLauncher merges: `process.env ← plugin.env ← request.env` |
| FR-006 | Do NOT delete `PHASE_TO_COMMAND`, Claude flags, or the old arg-building code | P2 | Cleanup deferred to Wave 3 Cleanup issue |
| FR-007 | Update `ClaudeCliWorker` to pass its already-created `AgentLauncher` instance to `CliSpawner` constructor | P1 | Worker already creates launcher at lines 110–117 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Snapshot parity | Byte-identical spawn args/env vs pre-refactor snapshot | `cli-spawner-snapshot.test.ts` with `RecordingProcessFactory` through `AgentLauncher` |
| SC-002 | Existing test pass rate | 100% of existing cli-spawner tests pass | `pnpm test` in orchestrator package — no test modifications |
| SC-003 | Integration validation | Full phase loop produces identical argv+env | Integration test against mock `claude` binary echoing its inputs |

## Technical Design Notes

### Injection change

```typescript
// Before
constructor(processFactory: ProcessFactory, logger: Logger, shutdownGracePeriodMs?: number)

// After
constructor(agentLauncher: AgentLauncher, processFactory: ProcessFactory, logger: Logger, shutdownGracePeriodMs?: number)
```

`ProcessFactory` is retained because `spawnValidate()` and `spawnPreValidate()` still use it directly (migrated in Phase 3d).

### spawnPhase migration

```typescript
// Before
const args = ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--verbose'];
if (resumeSessionId) args.push('--resume', resumeSessionId);
args.push(prompt);
const handle = this.processFactory.spawn('claude', args, { cwd, env });

// After
const launchHandle = this.agentLauncher.launch({
  intent: { kind: 'phase', phase, prompt, sessionId: resumeSessionId },
  cwd,
  env,
  signal,
});
const handle = launchHandle.process;
```

### Environment merging

AgentLauncher performs a 3-layer merge: `process.env ← launchSpec.env ← request.env`. The current code passes explicit env to `ProcessFactory`. After migration, passing env via `LaunchRequest.env` preserves caller-wins semantics since `request.env` has highest priority in the merge.

## Assumptions

- `ClaudeCodeLaunchPlugin.buildPhaseLaunch()` produces byte-identical args to current `spawnPhase()` arg building (validated by Wave 1 snapshot tests)
- `AgentLauncher` is already instantiated and plugin-registered in `ClaudeCliWorker` (confirmed at lines 110–117)
- `manageProcess()` is agnostic to how the `ChildProcessHandle` was created — it only needs the handle interface

## Out of Scope

- `pr-feedback-handler.ts` migration (Phase 3b, separate issue)
- `conversation-spawner.ts` migration (Phase 3c, separate issue)
- `spawnValidate` / `spawnPreValidate` migration (Phase 3d, separate issue)
- Deletion of `PHASE_TO_COMMAND` or legacy arg-building code (Wave 3 Cleanup issue)
- Changes to `ClaudeCodeLaunchPlugin` itself (delivered in Wave 2)

## Dependencies

- **Depends on**: Wave 2 Claude Plugin issue (delivers `ClaudeCodeLaunchPlugin` with `PhaseIntent` support)
- **Parallel-safe with**: Phases 3b, 3c, 3d (each migrates a different spawn site)
- **Blocks**: Wave 3 Cleanup (cannot remove legacy code until all 3a–3d land)

## References

- Parent tracking: [#423](https://github.com/generacy-ai/generacy/issues/423)
- Spawn refactor plan: [spawn-refactor-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites)

## Key Files

| File | Role |
|------|------|
| `packages/orchestrator/src/worker/cli-spawner.ts` | Migration target — `spawnPhase()` method |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Wiring — passes `AgentLauncher` to `CliSpawner` |
| `packages/orchestrator/src/launcher/agent-launcher.ts` | Plugin-based launcher (no changes needed) |
| `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` | Phase intent handler (no changes needed) |
| `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` | Unit tests (~60 cases, must pass unchanged) |
| `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts` | Snapshot tests (verify byte-identical output) |

---

*Generated by speckit*
