# Research: Phase 3a — Migrate spawnPhase to AgentLauncher

## Technology Decisions

### 1. AgentLauncher injection pattern: Constructor injection (not method injection)

**Decision**: Add `AgentLauncher` as a constructor parameter to `CliSpawner`, matching the existing `ProcessFactory` injection pattern.

**Rationale**: `CliSpawner` already takes `ProcessFactory` via constructor injection. Using the same pattern for `AgentLauncher` keeps the DI approach consistent and makes the dependency visible at construction time. Method injection (passing `agentLauncher` per-call) was rejected because it would change the `spawnPhase()` signature, requiring changes to `PhaseLoop` which is out of scope.

### 2. Keep ProcessFactory alongside AgentLauncher

**Decision**: `CliSpawner` retains both `AgentLauncher` (for `spawnPhase`) and `ProcessFactory` (for `runValidatePhase` / `runPreValidateInstall`).

**Rationale**: `runValidatePhase` and `runPreValidateInstall` spawn shell commands (`sh -c`), not Claude CLI. Migrating these to `AgentLauncher` is Phase 3d work. Removing `ProcessFactory` prematurely would break these methods.

**Alternative considered**: Migrate all three methods at once. Rejected — the spec explicitly scopes this to `spawnPhase()` only, and shell spawns use a different intent kind.

### 3. Do NOT pass signal to AgentLauncher.launch()

**Decision**: Omit `signal` from the `LaunchRequest` passed to `agentLauncher.launch()`.

**Rationale**: `manageProcess()` already handles abort-signal propagation (lines 192–204 of cli-spawner.ts). If `signal` were also passed to `launch()`, `AgentLauncher` would forward it to `factory.spawn()`, and the factory would attach a Node.js-level abort listener. This creates a double-kill race: both `manageProcess()` and the Node.js signal handler would try to kill the process simultaneously.

The `LaunchRequest.signal` field exists for callers that don't have their own signal management (e.g., one-shot launchers). `CliSpawner` manages its own lifecycle.

### 4. Ignore LaunchHandle.outputParser

**Decision**: Extract `handle.process` from the `LaunchHandle` and discard `handle.outputParser`.

**Rationale**: `ClaudeCodeLaunchPlugin.createOutputParser()` returns a no-op parser. The real stdout parsing is done by `OutputCapture`, which is passed separately to `manageProcess()`. Transitioning to the plugin's parser is a future wave (after all Phase 3 migrations complete and all spawn sites use `AgentLauncher`).

### 5. Remove pre-spawn validation, not PHASE_TO_COMMAND

**Decision**: Remove the `PHASE_TO_COMMAND[phase] === null` check from `spawnPhase()`, but keep the `PHASE_TO_COMMAND` constant in `worker/types.ts`.

**Rationale**:
- The check is redundant: `PhaseIntent.phase` type (`'specify' | 'clarify' | 'plan' | 'tasks' | 'implement'`) excludes `'validate'` at compile time, so it's impossible to construct a `PhaseIntent` for the validate phase.
- `PHASE_TO_COMMAND` is still referenced by `phase-loop.ts` (line 147) to distinguish CLI phases from validation phases. Deleting it is Wave 3 Cleanup (#435).

### 6. Snapshot env normalization strategy

**Decision**: Use `normalizeSpawnRecords()` to strip/normalize env in snapshots rather than mocking `process.env`.

**Rationale**: Mocking `process.env` is fragile and can break other code that depends on it. The `normalizeSpawnRecords()` utility was designed for exactly this purpose — creating stable, comparable snapshots. If it doesn't already strip env, we extend it.

## Implementation Patterns

### Pattern: Extract-and-delegate

The migration follows the standard "extract-and-delegate" refactoring pattern:
1. **Extract** the argument construction logic (already done in Wave 2 — lives in `ClaudeCodeLaunchPlugin.buildPhaseLaunch()`)
2. **Delegate** the spawn call from `spawnPhase()` to `agentLauncher.launch()`
3. **Extract process** from `LaunchHandle` for existing lifecycle management

This keeps `manageProcess()` completely unchanged — it still receives a `ChildProcessHandle` regardless of how the process was created.

### Pattern: Type narrowing at boundary

The `spawnPhase()` method accepts `WorkflowPhase` (which includes `'validate'`), but `PhaseIntent.phase` excludes it. Two options:
- **Narrow the parameter type** of `spawnPhase()` to `Exclude<WorkflowPhase, 'validate'>` — clean but changes the interface
- **Assert at runtime** — `if (phase === 'validate') throw ...` before constructing the intent

The plan recommends narrowing the type since `phase-loop.ts` already routes `validate` to `runValidatePhase()`, never to `spawnPhase()`. Callers that somehow pass `'validate'` should get a compile-time error, not a runtime one.

## Key Sources

- `packages/orchestrator/src/launcher/agent-launcher.ts` — AgentLauncher implementation (env merge at lines 62–71)
- `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts` — Plugin's `buildPhaseLaunch()` (lines 65–85)
- `packages/orchestrator/src/worker/cli-spawner.ts` — Migration target (lines 37–81)
- `packages/orchestrator/src/worker/claude-cli-worker.ts` — Construction site (line 338)
- Spec: `specs/431-goal-phase-3a-spawn/spec.md`
