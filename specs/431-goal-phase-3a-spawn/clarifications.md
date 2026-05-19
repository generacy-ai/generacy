# Clarifications: Phase 3a — Migrate cli-spawner.spawnPhase to AgentLauncher

## Batch 1 — 2026-04-12

### Q1: Test Modification Scope
**Context**: SC-002 requires "100% of existing cli-spawner tests pass — no test modifications", but US2 states "Tests can inject a mock/recording AgentLauncher just as they inject mock ProcessFactory today." Adding `AgentLauncher` as a new constructor parameter will break every existing test that instantiates `CliSpawner`, requiring updates to pass a mock launcher.
**Question**: Does "no test modifications" in SC-002 mean no changes to test *assertions and behavioral logic* (constructor call-site updates are acceptable), or does it literally mean zero changes to test files?

**Answer**: "No test modifications" means assertions and behavioral logic stay the same — constructor call-site updates are acceptable. Tests still verify phase sequencing, session resume, abort handling, stdout capture, timeout → SIGTERM → SIGKILL. Constructor calls update mechanically (e.g., `new CliSpawner(agentLauncher, mockLogger, 50)`). If a test assertion was testing `ProcessFactory.spawn()` call signature directly, rewrite it to assert on `RecordingProcessFactory` output at the end of the AgentLauncher chain.

### Q2: Signal / Abort Double-Handling
**Context**: The spec's code example passes `signal` in the `LaunchRequest` to `agentLauncher.launch()`. However, `manageProcess()` already independently handles the abort signal — it listens for abort events and calls `gracefulKill()` on the child process. If `AgentLauncher.launch()` also acts on the signal (e.g., killing the process), there could be a double-kill race condition.
**Question**: Should `signal` be passed to `AgentLauncher.launch()` as shown in the spec, or should abort handling remain exclusively in `manageProcess()`? If both handle it, what prevents a race?

**Answer**: Do NOT pass signal to `AgentLauncher.launch()`; abort handling stays exclusively in `manageProcess()`. Pass `signal: undefined` (or omit it) in the `LaunchRequest`. `manageProcess()` continues as the sole signal handler. The `LaunchRequest.signal` field exists for callers without their own signal logic (e.g., #430). Passing signal would risk a double-kill race if the factory ever wires it to Node.js `child_process.spawn`.

### Q3: LaunchHandle.outputParser Usage
**Context**: `AgentLauncher.launch()` returns a `LaunchHandle` containing both `.process` (the `ChildProcessHandle`) and `.outputParser` (plugin-created parser). The spec only mentions extracting `.process` for `manageProcess()`. Currently, `spawnPhase()` uses `OutputCapture` for stdout parsing. The `outputParser` from the plugin is not addressed.
**Question**: Should `spawnPhase()` ignore `LaunchHandle.outputParser` in this phase (continue using `OutputCapture`), or should it transition to using the plugin's output parser? If ignored, is this intentional tech debt for a later phase?

**Answer**: Ignore `LaunchHandle.outputParser`; continue using `OutputCapture` — intentional tech debt. Extract `handle.process` and ignore `handle.outputParser`. `OutputCapture` continues to work since the `ChildProcessHandle` is the same regardless of spawn path. Consolidating to plugin-provided parsers can happen in a follow-on pass after all Wave 3 migrations land.

### Q4: Snapshot Test Target Path
**Context**: SC-001 requires "byte-identical spawn args/env vs pre-refactor snapshot." The existing `cli-spawner-snapshot.test.ts` (66 lines) captures spawn arguments. After migration, the spawn flows through `AgentLauncher` → `ClaudeCodeLaunchPlugin` → `ProcessFactory` instead of directly through `ProcessFactory`.
**Question**: Should the snapshot test verify the final args reaching `ProcessFactory` (end-to-end through the new AgentLauncher path), or should it continue testing the old direct path? If end-to-end, should it use a `RecordingProcessFactory` injected into `AgentLauncher`?

**Answer**: End-to-end through the new path, using `RecordingProcessFactory` injected into `AgentLauncher`. Test should: (1) Create `AgentLauncher` with `RecordingProcessFactory` and real `ClaudeCodeLaunchPlugin`, (2) Create `CliSpawner` with that `AgentLauncher`, (3) Call `spawnPhase()` with known inputs, (4) Assert `RecordingProcessFactory`'s captured `{command, args, env, cwd}` matches the pre-refactor snapshot from Wave 1 harness (#427).

### Q5: Phase Validation After Migration
**Context**: Currently `spawnPhase()` validates the phase against `PHASE_TO_COMMAND` before spawning (throwing if the phase is invalid). FR-006 says "Do NOT delete PHASE_TO_COMMAND" but doesn't specify whether it should still be used for pre-spawn validation. After migration, `ClaudeCodeLaunchPlugin.buildPhaseLaunch()` also references `PHASE_TO_COMMAND` internally.
**Question**: After migration, should `spawnPhase()` retain the `PHASE_TO_COMMAND` validation check before calling `agentLauncher.launch()` (defense-in-depth), or should validation be solely the plugin's responsibility?

**Answer**: Remove the validation from `spawnPhase()`; the plugin owns phase validation. `ClaudeCodeLaunchPlugin.buildLaunch()` owns the `PHASE_TO_COMMAND` map and will throw if the phase is invalid. The constant `PHASE_TO_COMMAND` stays per FR-006 (still referenced by `runValidatePhase`), but the validation *check* in `spawnPhase()` is removed. `PhaseIntent.phase` type already excludes `validate` at compile time (per #428 Q5), so invalid phases can't reach the plugin.
