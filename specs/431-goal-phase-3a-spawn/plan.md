# Implementation Plan: Phase 3a — Migrate spawnPhase to AgentLauncher

**Feature**: Migrate `CliSpawner.spawnPhase()` from direct `ProcessFactory.spawn()` to `AgentLauncher.launch()` with a `PhaseIntent`
**Branch**: `431-goal-phase-3a-spawn`
**Status**: Complete

## Summary

Replace the manual CLI argument construction in `CliSpawner.spawnPhase()` with a call to `AgentLauncher.launch()`, delegating command/args/env composition to `ClaudeCodeLaunchPlugin.buildPhaseLaunch()`. The `AgentLauncher` instance is injected into `CliSpawner` via its constructor, and the construction site in `claude-cli-worker.ts` is updated to pass it through. All existing behavioral tests continue to pass with only constructor wiring changes. A new end-to-end snapshot test validates spawn parity through the full `AgentLauncher → ClaudeCodeLaunchPlugin → RecordingProcessFactory` chain.

## Technical Context

- **Language**: TypeScript (strict)
- **Runtime**: Node.js
- **Test framework**: Vitest
- **Package manager**: pnpm (monorepo)
- **Key packages**:
  - `packages/orchestrator` — contains `CliSpawner`, `AgentLauncher`, `PhaseLoop`, `ClaudeCliWorker`
  - `packages/generacy-plugin-claude-code` — contains `ClaudeCodeLaunchPlugin`, `PhaseIntent` type

## Project Structure

```
packages/orchestrator/src/
├── worker/
│   ├── cli-spawner.ts                          ← PRIMARY MIGRATION TARGET
│   ├── claude-cli-worker.ts                    ← CONSTRUCTION SITE UPDATE
│   ├── phase-loop.ts                           ← NO CHANGES (consumes CliSpawner)
│   ├── types.ts                                ← NO CHANGES (keep PHASE_TO_COMMAND)
│   └── __tests__/
│       ├── cli-spawner.test.ts                 ← UPDATE constructor wiring
│       ├── cli-spawner-snapshot.test.ts         ← UPDATE to use AgentLauncher path
│       └── __snapshots__/
│           └── cli-spawner-snapshot.test.ts.snap ← REGENERATE (should be byte-identical)
├── launcher/
│   ├── agent-launcher.ts                       ← EXISTING (no changes)
│   └── types.ts                                ← EXISTING (LaunchHandle, LaunchRequest)
└── test-utils/
    ├── recording-process-factory.ts            ← EXISTING (used by snapshot tests)
    └── spawn-snapshot.ts                       ← EXISTING (normalizeSpawnRecords)

packages/generacy-plugin-claude-code/src/launch/
├── claude-code-launch-plugin.ts                ← EXISTING (no changes)
├── types.ts                                    ← EXISTING (PhaseIntent)
└── constants.ts                                ← EXISTING (PHASE_TO_COMMAND)
```

## Implementation Tasks

### Task 1: Add AgentLauncher to CliSpawner constructor

**File**: `packages/orchestrator/src/worker/cli-spawner.ts`

- Add `AgentLauncher` import from `../launcher/agent-launcher.js`
- Add `agentLauncher: AgentLauncher` as the first constructor parameter
- Keep `processFactory` — still needed by `runValidatePhase()` and `runPreValidateInstall()`

```typescript
constructor(
  private readonly agentLauncher: AgentLauncher,
  private readonly processFactory: ProcessFactory,
  private readonly logger: Logger,
  private readonly shutdownGracePeriodMs: number = 5000,
) {}
```

### Task 2: Replace spawn logic in spawnPhase()

**File**: `packages/orchestrator/src/worker/cli-spawner.ts`

Replace the manual argument construction + `processFactory.spawn()` call with `agentLauncher.launch()`:

**Before** (lines 42–80):
```typescript
const command = PHASE_TO_COMMAND[phase];
if (command === null) {
  throw new Error(`Phase "${phase}" has no CLI command (...)`);
}
const prompt = `${command} ${options.prompt}`;
const args = ['-p', '--output-format', 'stream-json', ...];
if (options.resumeSessionId) { args.push('--resume', ...); }
args.push(prompt);
const child = this.processFactory.spawn('claude', args, { cwd, env });
```

**After**:
```typescript
const handle = this.agentLauncher.launch({
  intent: {
    kind: 'phase',
    phase,
    prompt: options.prompt,
    sessionId: options.resumeSessionId,
  },
  cwd: options.cwd,
  env: options.env,
});
const child = handle.process;
```

Key decisions:
- **Remove the `PHASE_TO_COMMAND[phase] === null` validation check**: `PhaseIntent.phase` type (`'specify' | 'clarify' | 'plan' | 'tasks' | 'implement'`) excludes `'validate'` at compile time. The plugin owns validation.
- **Do NOT pass `signal`** to `agentLauncher.launch()`: Abort-signal handling remains exclusively in `manageProcess()` to prevent double-kill race.
- **Ignore `handle.outputParser`**: Existing `OutputCapture` continues to handle stdout parsing (intentional tech debt).
- **Pass `options.prompt` (the issue URL)**, not the composed `${command} ${prompt}` — the plugin composes the slash command from `PhaseIntent.phase`.

### Task 3: Update claude-cli-worker.ts construction site

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

Pass `this.agentLauncher` as the first argument to the `CliSpawner` constructor (line 338):

```typescript
const cliSpawner = new CliSpawner(
  this.agentLauncher,
  this.processFactory,
  workerLogger,
  this.config.shutdownGracePeriodMs,
);
```

### Task 4: Update unit test constructor wiring

**File**: `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts`

- Create a mock `AgentLauncher` that wraps the existing mock `ProcessFactory`
- Wire a real `ClaudeCodeLaunchPlugin` into the mock launcher (so the args flow through the plugin)
- **OR** create a minimal mock `AgentLauncher` with a `launch()` that returns `{ process: handle, outputParser: noopParser, metadata: {...} }`
- Update the `CliSpawner` constructor call in `beforeEach` to pass the mock launcher as the first arg

**Critical constraint**: Only constructor call-sites change. All behavioral assertions (phase sequencing, session resume, abort, env inheritance, timeout) remain identical.

Recommended approach — use a mock AgentLauncher that delegates to the existing mock factory via the real plugin:

```typescript
const agentLauncher = new AgentLauncher(new Map([['default', factory]]));
agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
spawner = new CliSpawner(agentLauncher, factory, mockLogger, 50);
```

This is preferable because:
1. It exercises the real plugin path (higher confidence)
2. The existing `spawnFn` assertions still work — `RecordingProcessFactory`/mock factory captures the call that comes out of `AgentLauncher.launch()`

**However**, there is a subtlety: `AgentLauncher.launch()` merges `process.env` into the env (line 63-71 of agent-launcher.ts). The existing tests pass explicit env like `{ PATH: '/usr/bin' }` and assert on what `factory.spawn` receives. After the migration, the factory will receive `{ ...process.env, ...options.env }` instead of just `{ PATH: '/usr/bin' }`.

This means existing tests that assert on exact env values will need adjustment. Two options:
- **Option A**: Tests use `expect.objectContaining({ PATH: '/usr/bin' })` for env assertions
- **Option B**: Tests mock `process.env` to be empty during the test

The spec says "behavioral assertions unchanged" — env enrichment from AgentLauncher's 3-layer merge is a behavioral change in the env surface area. The snapshot test (Task 5) is designed to validate full end-to-end parity, so unit tests should accept the enriched env.

### Task 5: Update snapshot test to use AgentLauncher path

**File**: `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts`

The snapshot test already uses `RecordingProcessFactory`. Update it to route through `AgentLauncher → ClaudeCodeLaunchPlugin → RecordingProcessFactory`:

```typescript
import { AgentLauncher } from '../../launcher/agent-launcher.js';
import { ClaudeCodeLaunchPlugin } from '@generacy-ai/generacy-plugin-claude-code';

const factory = new RecordingProcessFactory();
const launcher = new AgentLauncher(new Map([['default', factory]]));
launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
const spawner = new CliSpawner(launcher, factory, noopLogger);
```

After running, compare the new snapshot to the pre-refactor snapshot. The `command` and `args` fields should be byte-identical. The `env` field will include `process.env` entries from the AgentLauncher merge — the `normalizeSpawnRecords()` utility should handle this (strip or normalize env for comparison). If it doesn't, update the normalizer.

### Task 6: Remove dead code from spawnPhase

After the migration, the following can be removed from `spawnPhase()`:
- The `PHASE_TO_COMMAND[phase]` lookup and null check (lines 42-45)
- The manual `args` array construction (lines 49-61)
- The `this.processFactory.spawn('claude', args, ...)` call (lines 75-78)

The `PHASE_TO_COMMAND` import should remain — it's still used by `phase-loop.ts` (line 147: `PHASE_TO_COMMAND[phase] === null` check) and indirectly by `runValidatePhase`. Per FR-006, do NOT delete the constant itself.

The `prompt` local variable (line 47) is no longer needed — the plugin composes the full prompt.

### Task 7: Update spawnPhase logging

The existing log at line 63 references `options.resumeSessionId`. This stays, but add the fact that it's going through AgentLauncher:

```typescript
this.logger.info(
  {
    phase,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    resumeSessionId: options.resumeSessionId ?? null,
  },
  options.resumeSessionId
    ? 'Resuming Claude CLI session for phase (via AgentLauncher)'
    : 'Spawning new Claude CLI session for phase (via AgentLauncher)',
);
```

## Env Merge Consideration

`AgentLauncher.launch()` performs a 3-layer env merge: `process.env ← plugin env ← caller env`. The current `spawnPhase()` passes `options.env` directly (no process.env merge). After migration, the spawned process will receive `{ ...process.env, ...options.env }`.

This is fine because `defaultProcessFactory` in `claude-cli-worker.ts` (line 38) already does `env: { ...process.env, ...options.env }`. So the final env reaching the child process was always `process.env + options.env` — the merge just moves from the factory layer to the launcher layer. The `RecordingProcessFactory` in tests captures what the factory receives (post-launcher-merge), so snapshots will include process.env keys.

The `normalizeSpawnRecords()` function should strip or normalize env to keep snapshots stable. Check if it already does this; if not, update it.

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Double env merge (launcher + factory) | `RecordingProcessFactory` uses passthrough; real `defaultProcessFactory` merges — but AgentLauncher already provides the full merged env, so factory's `{ ...process.env, ...options.env }` is a no-op over an already-merged env |
| Double signal handling (launcher + manageProcess) | Per FR-005, do NOT pass `signal` to `agentLauncher.launch()` |
| Snapshot drift from process.env | `normalizeSpawnRecords()` should normalize env; update if needed |
| Type mismatch on `phase` param | `spawnPhase` accepts `WorkflowPhase` (includes `'validate'`), but `PhaseIntent.phase` excludes it. The removed validation check handled this; now TypeScript's type system handles it at compile time. Consider narrowing `spawnPhase`'s `phase` parameter type or adding a runtime guard that throws before reaching the launcher. |

## Verification Plan

1. **Unit tests**: `pnpm --filter orchestrator test -- cli-spawner.test.ts`
   - All existing behavioral assertions pass with updated constructor wiring
2. **Snapshot tests**: `pnpm --filter orchestrator test -- cli-spawner-snapshot.test.ts`
   - Spawn args are byte-identical to pre-refactor
3. **Type check**: `pnpm --filter orchestrator typecheck`
   - No type errors from the migration
4. **Full test suite**: `pnpm --filter orchestrator test`
   - No regressions across the package
