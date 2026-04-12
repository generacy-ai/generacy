# Implementation Plan: Migrate conversation-spawner to AgentLauncher

**Feature**: Route interactive conversation turns through `AgentLauncher` + `ClaudeCodeLaunchPlugin`
**Branch**: `433-goal-phase-3c-spawn`
**Status**: Complete

## Summary

Replace the direct `processFactory.spawn('python3', ...)` call in `ConversationSpawner` with `agentLauncher.launch({ intent: { kind: 'conversation-turn', ... } })`. The `ClaudeCodeLaunchPlugin` already handles `conversation-turn` intents (added in Wave 2), so this issue is purely a caller-side migration: swap the dependency, adapt the call site, fix the double-merge in `conversationProcessFactory`, and update tests.

## Technical Context

- **Language**: TypeScript (ESM, `.js` extensions in imports)
- **Runtime**: Node.js
- **Framework**: Fastify (server.ts), Vitest (tests)
- **Key packages**: `packages/orchestrator`, `packages/generacy-plugin-claude-code`
- **Build**: pnpm monorepo

## Design Decisions (from clarifications)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Constructor injection | **A: Replace entirely** — `(agentLauncher, gracePeriodMs)` | `processFactory` only used in spawn paths, all of which route through Claude plugin |
| AgentLauncher wiring | **C: Shared setup function** — `createAgentLauncher()` | Both `server.ts` and `claude-cli-worker.ts` need identical plugin registrations |
| Env merge | **C: Caller overrides + fix factory** | Remove `process.env` spread from `conversationProcessFactory`; AgentLauncher owns base layer |
| Test modification | **B: Mock setup changes, assertions equivalent** | Mock target changes from `processFactory.spawn()` to `agentLauncher.launch()` |
| AbortSignal | **A: Omit** — keep migration minimal | Pass `signal: undefined`; abort support is a follow-up |

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── launcher/
│   │   ├── agent-launcher.ts           # AgentLauncher class (unchanged)
│   │   ├── launcher-setup.ts           # NEW — shared createAgentLauncher() factory
│   │   ├── types.ts                    # LaunchRequest, LaunchHandle, etc (unchanged)
│   │   └── generic-subprocess-plugin.ts
│   ├── conversation/
│   │   ├── conversation-spawner.ts     # MODIFY — replace processFactory with agentLauncher
│   │   ├── process-factory.ts          # MODIFY — remove process.env double-merge
│   │   └── __tests__/
│   │       ├── conversation-spawner.test.ts  # MODIFY — mock agentLauncher.launch()
│   │       └── conversation-manager.test.ts  # UNCHANGED — mocks spawner.spawnTurn()
│   ├── worker/
│   │   └── claude-cli-worker.ts        # MODIFY — use createAgentLauncher()
│   └── server.ts                       # MODIFY — use createAgentLauncher(), pass to spawner
packages/generacy-plugin-claude-code/
└── src/launch/
    ├── claude-code-launch-plugin.ts    # UNCHANGED — already handles conversation-turn
    └── types.ts                        # UNCHANGED — ConversationTurnIntent defined
```

## Implementation Steps

### Step 1: Create shared `createAgentLauncher()` factory

**File**: `packages/orchestrator/src/launcher/launcher-setup.ts` (new)

Create a factory function that encapsulates the AgentLauncher construction pattern currently duplicated between `server.ts` and `claude-cli-worker.ts`:

```typescript
export function createAgentLauncher(factories: {
  default: ProcessFactory;
  interactive: ProcessFactory;
}): AgentLauncher {
  const launcher = new AgentLauncher(
    new Map([
      ['default', factories.default],
      ['interactive', factories.interactive],
    ]),
  );
  launcher.registerPlugin(new GenericSubprocessPlugin());
  launcher.registerPlugin(new ClaudeCodeLaunchPlugin());
  return launcher;
}
```

### Step 2: Fix `conversationProcessFactory` double-merge

**File**: `packages/orchestrator/src/conversation/process-factory.ts`

Remove the `process.env` spread — AgentLauncher already merges `process.env` as the base layer:

```diff
- env: { ...process.env, ...options.env },
+ env: options.env,
```

**Note**: Per clarification Q3, this coordinates with #425's ProcessFactory standardization. The double-merge is harmless (idempotent spread), but fixing it now is correct behavior since AgentLauncher will always be the caller after this migration.

### Step 3: Modify `ConversationSpawner` to use `AgentLauncher`

**File**: `packages/orchestrator/src/conversation/conversation-spawner.ts`

Changes:
1. Replace `ProcessFactory` import with `AgentLauncher` + `LaunchHandle` types
2. Constructor: `(agentLauncher: AgentLauncher, gracePeriodMs)` instead of `(processFactory, gracePeriodMs)`
3. Remove `PTY_WRAPPER` constant (lives in `ClaudeCodeLaunchPlugin` now)
4. `spawnTurn()`: build a `LaunchRequest` with `intent: { kind: 'conversation-turn', ... }` and call `agentLauncher.launch()`; return `launchHandle.process`
5. `spawn()` (deprecated): same pattern but without `-p`/message — build intent with appropriate fields
6. `gracefulKill()`: unchanged (operates on `ChildProcessHandle`, no factory dependency)

Key mapping from current code to LaunchRequest:

| Current | LaunchRequest |
|---------|---------------|
| `options.message` | `intent.message` |
| `options.sessionId` | `intent.sessionId` |
| `options.model` | `intent.model` |
| `options.skipPermissions` | `intent.skipPermissions` |
| `options.cwd` | `request.cwd` |
| `env: {}` | `request.env: {}` (empty caller overrides) |
| — | `request.signal: undefined` (omitted per Q5) |

### Step 4: Handle deprecated `spawn()` method

The deprecated `spawn()` method also invokes `python3 -u -c PTY_WRAPPER claude ...` but without `-p`. Currently `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` always includes `-p intent.message`.

Options:
- **Preferred**: Add a new intent kind `conversation-start` to the plugin, or make `message` optional in `ConversationTurnIntent`
- **Pragmatic**: Since `spawn()` is deprecated and only used for legacy interactive mode, it can be removed entirely if no callers exist, or kept with a direct `agentLauncher.launch()` call using a minimal intent

**Decision**: Check if `spawn()` has any remaining callers. If not, remove it. If yes, make `message` optional in `ConversationTurnIntent` and adjust the plugin to omit `-p` when message is absent.

### Step 5: Update `server.ts` wiring

**File**: `packages/orchestrator/src/server.ts`

```diff
- import { conversationProcessFactory } from './conversation/process-factory.js';
+ import { createAgentLauncher } from './launcher/launcher-setup.js';
+ import { conversationProcessFactory } from './conversation/process-factory.js';
+ import { defaultProcessFactory } from './worker/claude-cli-worker.js';

  // Before ConversationSpawner creation:
+ const agentLauncher = createAgentLauncher({
+   default: defaultProcessFactory,
+   interactive: conversationProcessFactory,
+ });

  const conversationSpawner = new ConversationSpawner(
-   conversationProcessFactory,
+   agentLauncher,
    config.conversations.shutdownGracePeriodMs,
  );
```

### Step 6: Update `claude-cli-worker.ts` wiring

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

```diff
+ import { createAgentLauncher } from '../launcher/launcher-setup.js';

  // In constructor:
- this.agentLauncher = new AgentLauncher(
-   new Map([
-     ['default', this.processFactory],
-     ['interactive', conversationProcessFactory],
-   ]),
- );
- this.agentLauncher.registerPlugin(new GenericSubprocessPlugin());
- this.agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin());
+ this.agentLauncher = createAgentLauncher({
+   default: this.processFactory,
+   interactive: conversationProcessFactory,
+ });
```

### Step 7: Update `conversation-spawner.test.ts`

**File**: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts`

Mock target changes from `processFactory.spawn()` to `agentLauncher.launch()`:

```typescript
const launchFn = vi.fn();
const { handle } = createMockProcess();
launchFn.mockReturnValue({ process: handle, outputParser: noopParser, metadata: { pluginId: 'claude-code', intentKind: 'conversation-turn' } });
const launcher = { launch: launchFn } as unknown as AgentLauncher;
const spawner = new ConversationSpawner(launcher);
```

Assertions shift from checking spawn args to checking the LaunchRequest intent:

```typescript
expect(launchFn).toHaveBeenCalledWith(
  expect.objectContaining({
    intent: expect.objectContaining({
      kind: 'conversation-turn',
      message: 'hello',
      skipPermissions: true,
    }),
    cwd: '/workspace',
  }),
);
```

**Existing `spawn()` tests**: Update mock setup similarly. If `spawn()` is removed, delete these tests.

**`gracefulKill()` tests**: Minimal change — constructor mock changes but kill logic is unchanged.

**`conversation-manager.test.ts`**: ZERO changes expected — it mocks `spawner.spawnTurn()` directly, not the underlying launcher.

### Step 8: Add snapshot test for spawn command parity

**File**: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts` (or new snapshot file)

Per acceptance criteria, add a snapshot test that captures the full LaunchRequest passed to `agentLauncher.launch()` for a conversation turn, verifying the intent fields match what `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` would produce.

Additionally, add a cross-package snapshot test (or co-locate with plugin tests) that verifies `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` produces a byte-identical command to the pre-refactor `python3 -u -c PTY_WRAPPER claude ...` invocation.

### Step 9: Add integration test with mock binary

**File**: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.integration.test.ts` (new)

Test the full path: `ConversationSpawner → AgentLauncher → ClaudeCodeLaunchPlugin → ProcessFactory → child process`. Use a mock binary (simple echo script) to verify:
- PTY wrapper is invoked
- stdin writing works
- stdout streaming works
- Process exit is handled correctly

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| PTY wrapper script content diverges | Snapshot test comparing plugin's PTY_WRAPPER against pre-refactor baseline |
| Double env merge causes subtle behavior change | Fix factory first, verify with unit test that env passthrough is clean |
| `spawn()` callers break | Search for callers before removing; if any exist, handle gracefully |
| `server.ts` doesn't have access to `defaultProcessFactory` | Export it from `claude-cli-worker.ts` (already exported) |

## Verification

1. `pnpm test --filter @generacy-ai/orchestrator` — all existing tests pass
2. `pnpm test --filter @generacy-ai/generacy-plugin-claude-code` — plugin tests pass
3. Snapshot tests confirm byte-identical spawn output
4. Integration test confirms end-to-end PTY wrapper invocation
