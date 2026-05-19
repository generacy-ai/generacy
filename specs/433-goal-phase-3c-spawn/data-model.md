# Data Model: Migrate conversation-spawner to AgentLauncher

**Feature**: #433 | **Branch**: `433-goal-phase-3c-spawn`

## Core Entities

### Modified: `ConversationSpawner`

The constructor dependency changes from `ProcessFactory` to `AgentLauncher`:

```typescript
// Before
class ConversationSpawner {
  constructor(
    processFactory: ProcessFactory,        // direct spawn control
    shutdownGracePeriodMs: number = 5000,
  )
}

// After
class ConversationSpawner {
  constructor(
    agentLauncher: AgentLauncher,          // plugin-dispatched launch
    shutdownGracePeriodMs: number = 5000,
  )
}
```

Methods unchanged in signature:
- `spawnTurn(options: ConversationTurnOptions): ConversationProcessHandle`
- `spawn(options: ConversationSpawnOptions): ConversationProcessHandle` (deprecated)
- `gracefulKill(handle: ChildProcessHandle): void`

### Existing: `ConversationTurnOptions` → `ConversationTurnIntent` mapping

| ConversationTurnOptions (caller) | ConversationTurnIntent (plugin) | Notes |
|----------------------------------|--------------------------------|-------|
| `message: string` | `message: string` | Direct mapping |
| `sessionId?: string` | `sessionId?: string` | Direct mapping |
| `model?: string` | `model?: string` | Direct mapping |
| `skipPermissions: boolean` | `skipPermissions: boolean` | Direct mapping |
| `cwd: string` | *(in LaunchRequest.cwd)* | Lifted to request level |

### Existing: `LaunchRequest` (used to call AgentLauncher)

```typescript
interface LaunchRequest {
  intent: LaunchIntent;      // { kind: 'conversation-turn', ... }
  cwd: string;               // from ConversationTurnOptions.cwd
  env?: Record<string, string>;  // {} (empty caller overrides)
  signal?: AbortSignal;      // undefined (omitted per Q5)
  detached?: boolean;        // undefined (not needed for conversations)
}
```

### Existing: `LaunchHandle` (returned by AgentLauncher)

```typescript
interface LaunchHandle {
  process: ChildProcessHandle;  // used as ConversationProcessHandle
  outputParser: OutputParser;   // no-op for conversation-turn
  metadata: { pluginId: 'claude-code'; intentKind: 'conversation-turn' };
}
```

### New: `createAgentLauncher()` factory function

```typescript
function createAgentLauncher(factories: {
  default: ProcessFactory;
  interactive: ProcessFactory;
}): AgentLauncher
```

Input: Two `ProcessFactory` instances keyed by stdio profile.
Output: Fully configured `AgentLauncher` with both plugins registered.

## Type Relationships

```
ConversationManager
  └── ConversationSpawner
        └── AgentLauncher                    (was: ProcessFactory)
              ├── ClaudeCodeLaunchPlugin
              │     └── buildConversationTurnLaunch()  → LaunchSpec
              └── Map<string, ProcessFactory>
                    ├── 'default'     → defaultProcessFactory
                    └── 'interactive' → conversationProcessFactory
```

## Validation Rules

- `ConversationTurnOptions.message` must be non-empty (enforced by caller, not spawner)
- `skipPermissions` is required (boolean, no default) — maps directly to intent
- `cwd` must be an absolute path (enforced by caller)
- `env: {}` is always passed as empty caller overrides (AgentLauncher merges process.env as base)

## Process Factory Env Contract (after fix)

```
Before:  factory receives options.env → spreads { ...process.env, ...options.env }
After:   factory receives options.env → passes through unchanged (options.env)

AgentLauncher merges: { ...process.env, ...pluginEnv, ...callerEnv }
Factory just uses:    { env: mergedEnv }  (already complete)
```
