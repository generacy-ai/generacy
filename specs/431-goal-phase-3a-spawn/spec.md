# Feature Specification: Phase 3a — Migrate cli-spawner.spawnPhase to AgentLauncher

**Branch**: `431-goal-phase-3a-spawn` | **Date**: 2026-04-12 | **Status**: Draft

## Summary

Flip the orchestrator's primary phase-loop spawn in `cli-spawner.ts:spawnPhase()` from direct `ProcessFactory.spawn("claude", args, ...)` to `AgentLauncher.launch()` with a `PhaseIntent`. This is Phase 3a of the [spawn refactor](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites), consolidating all Claude CLI spawns behind the plugin-based `AgentLauncher` abstraction introduced in Waves 1–2.

## User Stories

### US1: Plugin-Based Phase Spawning

**As a** platform engineer,
**I want** `spawnPhase()` to delegate to `AgentLauncher` instead of directly calling `ProcessFactory`,
**So that** Claude CLI spawn logic is centralized in `ClaudeCodeLaunchPlugin` and future changes (model swaps, flag changes, new agent types) only need to be made in one place.

**Acceptance Criteria**:
- [ ] `spawnPhase()` calls `agentLauncher.launch()` with a `PhaseIntent` instead of building args and calling `processFactory.spawn()` directly
- [ ] The `AgentLauncher` instance is injected into `CliSpawner` via the constructor, alongside the existing `Logger` and `shutdownGracePeriodMs` parameters
- [ ] The spawned process args/env are byte-identical to the pre-refactor output (verified by snapshot test through full AgentLauncher → ClaudeCodeLaunchPlugin → RecordingProcessFactory chain)

### US2: Testable AgentLauncher Injection

**As a** developer writing tests for `CliSpawner`,
**I want** to inject a mock `AgentLauncher` the same way I inject a mock `ProcessFactory` today,
**So that** tests remain isolated and I can verify launch requests without spawning real processes.

**Acceptance Criteria**:
- [ ] `CliSpawner` constructor accepts an `AgentLauncher` parameter
- [ ] Existing test behavioral assertions (phase sequencing, session resume, abort, env inheritance) continue to pass with updated constructor call-sites (constructor wiring changes are acceptable; assertion/behavioral logic changes are not)
- [ ] Snapshot test validates the composed spawn through the full `AgentLauncher` → `ClaudeCodeLaunchPlugin` → `RecordingProcessFactory` chain, comparing against pre-refactor snapshot from Wave 1 harness (#427)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `AgentLauncher` as a constructor parameter to `CliSpawner` | P1 | Mirrors existing `ProcessFactory` injection pattern |
| FR-002 | Replace `processFactory.spawn('claude', args, ...)` in `spawnPhase()` with `agentLauncher.launch({ intent: { kind: 'phase', phase, prompt, sessionId }, cwd, env })` — omit `signal` | P1 | Core migration; signal omitted per Q2 clarification |
| FR-003 | Extract `LaunchHandle.process` from `launch()` return and pass to existing `manageProcess()`; ignore `LaunchHandle.outputParser` | P1 | `manageProcess()` is unchanged; outputParser ignored per Q3 (intentional tech debt) |
| FR-004 | Continue using `OutputCapture` for stdout parsing (ignore `LaunchHandle.outputParser`) | P1 | Plugin's outputParser is no-op; OutputCapture transition is out of scope (future follow-on after all Wave 3 migrations) |
| FR-005 | Preserve abort-signal handling exclusively in `manageProcess()`; do NOT pass `signal` to `agentLauncher.launch()` | P1 | Prevents double-kill race; `LaunchRequest.signal` is for callers without their own signal logic |
| FR-006 | Do NOT delete `PHASE_TO_COMMAND` mapping or Claude-specific flags; however, remove the pre-spawn validation check from `spawnPhase()` — plugin owns validation | P1 | Constant stays (referenced by `runValidatePhase`); validation check removed per Q5. `PhaseIntent.phase` type excludes invalid values at compile time. Cleanup deferred to Wave 3 (#435) |
| FR-007 | Update `claude-cli-worker.ts` to pass `AgentLauncher` when constructing `CliSpawner` | P1 | `agentLauncher` is already constructed at lines 109-117 |
| FR-008 | Remove `ProcessFactory` from `CliSpawner` constructor (no longer directly used by `spawnPhase`) | P2 | Only if `runValidatePhase`/`runPreValidateInstall` also migrate; otherwise keep for those methods |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Spawn args/env parity | Byte-identical to pre-refactor snapshot | `cli-spawner-snapshot.test.ts` updated to spawn end-to-end through `AgentLauncher` → `ClaudeCodeLaunchPlugin` → `RecordingProcessFactory` path; snapshot matches Wave 1 harness (#427) |
| SC-002 | Existing test pass rate | 100% of existing cli-spawner test assertions pass | `cli-spawner.test.ts` — constructor call-sites updated (wiring changes acceptable), but behavioral assertions unchanged |
| SC-003 | Integration test | Full phase loop completes with identical argv+env | End-to-end test against mock `claude` binary echoing argv+env |
| SC-004 | No runtime behavior change | Zero diff in phase sequencing, resume, abort, env, stream-json parsing | Manual + automated verification |

## Scope

### In Scope
- Migrate `spawnPhase()` in `cli-spawner.ts` to use `AgentLauncher.launch()`
- Inject `AgentLauncher` into `CliSpawner` constructor
- Update `claude-cli-worker.ts` construction site
- Update test constructor call-sites to pass mock `AgentLauncher`
- Snapshot test through new `AgentLauncher` path

### Out of Scope
- `pr-feedback-handler.ts` migration (Phase 3b)
- `conversation-spawner.ts` migration (Phase 3c)
- `runValidatePhase` / `runPreValidateInstall` shell spawns in `cli-spawner.ts:102` / `:129` (Phase 3d)
- Deletion of `PHASE_TO_COMMAND` (Wave 3 Cleanup)
- Transitioning to plugin's `OutputParser` (future wave)

## Assumptions

- Wave 2 (`ClaudeCodeLaunchPlugin`) is merged and available on `develop`
- `AgentLauncher` is already instantiated in `claude-cli-worker.ts` with both `default` and `interactive` process factories registered
- `ClaudeCodeLaunchPlugin.buildPhaseLaunch()` produces args identical to what `spawnPhase()` builds today
- `manageProcess()` requires no changes — it operates on `ChildProcessHandle` regardless of how the process was created

## Dependencies

- **Hard**: Wave 2 Claude Plugin issue (provides `ClaudeCodeLaunchPlugin`)
- **Parallel-safe**: Phase 3b, 3c, 3d (touch different spawn sites)

## References

- Parent tracking: #423
- [Spawn refactor plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md)
- Key files:
  - `packages/orchestrator/src/worker/cli-spawner.ts` — migration target
  - `packages/orchestrator/src/launcher/agent-launcher.ts` — AgentLauncher
  - `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — ClaudeCodeLaunchPlugin
  - `packages/orchestrator/src/worker/claude-cli-worker.ts` — construction site

---

*Generated by speckit*
