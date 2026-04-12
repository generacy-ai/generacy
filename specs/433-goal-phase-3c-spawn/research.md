# Research: Migrate conversation-spawner to AgentLauncher

**Feature**: #433 | **Branch**: `433-goal-phase-3c-spawn`

## Technology Decisions

### 1. Shared AgentLauncher Factory Function

**Decision**: Create `createAgentLauncher()` in `launcher-setup.ts` rather than duplicating setup.

**Rationale**: Both `server.ts` and `claude-cli-worker.ts` need an AgentLauncher with identical plugin registrations (`ClaudeCodeLaunchPlugin`, `GenericSubprocessPlugin`) and the same factory map shape (`default` + `interactive`). A shared factory function prevents registration drift.

**Alternatives considered**:
- **Duplicate in server.ts**: Simple but risks plugin registration inconsistencies as plugins evolve.
- **Pass from ClaudeCliWorker**: Creates coupling between worker and conversation subsystems that doesn't exist today; worker lifecycle differs from server lifecycle.

### 2. Full Constructor Replacement (not transitional)

**Decision**: Replace `processFactory` with `agentLauncher` in the `ConversationSpawner` constructor entirely.

**Rationale**: `processFactory` is only used in `spawnTurn()` and `spawn()` — both Claude-specific invocations. `AgentLauncher` wraps `ProcessFactory` internally, so nothing is lost. A transitional period with both dependencies adds complexity without benefit since there are no non-Claude spawn paths.

**Alternatives considered**:
- **Accept both deps**: Adds unused `processFactory` parameter; confusing API surface.
- **Method injection**: Scatters the dependency across call sites.

### 3. Environment Merge Fix (not double-merge tolerance)

**Decision**: Fix `conversationProcessFactory` to pass `options.env` through unchanged instead of re-merging `process.env`.

**Rationale**: AgentLauncher's 3-layer merge (`process.env ← plugin env ← caller env`) is the canonical merge point. Factories should be env-transparent. The double-merge is currently harmless (idempotent spread of identical `process.env`), but fixing it:
- Makes the data flow explicit and auditable
- Prevents subtle bugs if plugin env ever differs from process.env
- Aligns with #425's ProcessFactory standardization decision (Q4 answer C)

**Risk**: If any code path bypasses AgentLauncher and calls `conversationProcessFactory.spawn()` directly with a partial env, it would lose `process.env` vars. Mitigated by: this migration makes AgentLauncher the sole caller.

### 4. No AbortSignal (minimal migration)

**Decision**: Omit `AbortSignal` plumbing. Pass `signal: undefined` in LaunchRequest.

**Rationale**: `spawnTurn()` has no signal parameter today. The conversation system manages lifecycle through `ConversationManager.end()` → `spawner.gracefulKill()`. Adding abort support is additive and belongs in a follow-up issue.

## Implementation Patterns

### Pattern: LaunchRequest construction from ConversationTurnOptions

```typescript
// Before (direct processFactory call)
this.processFactory.spawn('python3', ['-u', '-c', PTY_WRAPPER, ...claudeArgs], {
  cwd: options.cwd,
  env: {},
});

// After (AgentLauncher dispatch)
const { process } = this.agentLauncher.launch({
  intent: {
    kind: 'conversation-turn',
    message: options.message,
    sessionId: options.sessionId,
    model: options.model,
    skipPermissions: options.skipPermissions,
  },
  cwd: options.cwd,
  env: {},
});
```

The key insight: all command composition logic (python3, PTY_WRAPPER, claude args, flag ordering) moves to `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()`, which already implements it identically.

### Pattern: Test mock migration

```typescript
// Before: mock ProcessFactory
const spawnFn = vi.fn().mockReturnValue(handle);
const factory = { spawn: spawnFn } as unknown as ProcessFactory;
const spawner = new ConversationSpawner(factory);
// Assert: spawnFn called with ('python3', [...args], { cwd })

// After: mock AgentLauncher
const launchFn = vi.fn().mockReturnValue({ process: handle, ... });
const launcher = { launch: launchFn } as unknown as AgentLauncher;
const spawner = new ConversationSpawner(launcher);
// Assert: launchFn called with ({ intent: { kind, message, ... }, cwd })
```

Assertions become more semantic (checking intent fields) rather than positional (checking arg arrays).

## Key Sources

- [Spawn Refactor Plan — Phase 3](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/spawn-refactor-plan.md#phase-3--migrate-orchestrator-spawn-sites) — parent plan defining Wave 3 migration order
- Issue #425 — ProcessFactory standardization decisions (env merge ownership)
- Issue #428 — Wave 2 Claude Plugin (added `conversation-turn` intent to ClaudeCodeLaunchPlugin)
- `AgentLauncher.launch()` at `packages/orchestrator/src/launcher/agent-launcher.ts:47` — 3-layer env merge + factory dispatch
- `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` at `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts:103` — the target implementation already in place
