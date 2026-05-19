# Data Model: Consolidate root-level claude-code-invoker

## New Types

### InvokeIntent (in `generacy-plugin-claude-code`)

```typescript
/**
 * Intent for invoking Claude CLI with a raw command string.
 * Used by the root-level ClaudeCodeInvoker adapter.
 * Produces: claude --print --dangerously-skip-permissions <command>
 */
export interface InvokeIntent {
  kind: 'invoke';
  /** Raw command string (e.g., "/speckit:specify https://...") */
  command: string;
  /** Whether to stream output (reserved for future use) */
  streaming?: boolean;
}
```

**Location**: `packages/generacy-plugin-claude-code/src/launch/types.ts`

## Modified Types

### ClaudeCodeIntent (extended union)

```typescript
// Before
export type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent;

// After
export type ClaudeCodeIntent = PhaseIntent | PrFeedbackIntent | ConversationTurnIntent | InvokeIntent;
```

**Location**: `packages/generacy-plugin-claude-code/src/launch/types.ts`

**Impact**: `LaunchIntent` in `packages/orchestrator/src/launcher/types.ts` auto-inherits `InvokeIntent` via the `ClaudeCodeIntent` import — no modification needed.

### ClaudeCodeLaunchPlugin (extended)

```typescript
// Before
readonly supportedKinds = ['phase', 'pr-feedback', 'conversation-turn'] as const;

// After
readonly supportedKinds = ['phase', 'pr-feedback', 'conversation-turn', 'invoke'] as const;
```

New method:
```typescript
private buildInvokeLaunch(intent: InvokeIntent): LaunchSpec {
  return {
    command: 'claude',
    args: ['--print', '--dangerously-skip-permissions', intent.command],
    stdioProfile: 'default',
  };
}
```

**Location**: `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`

### ClaudeCodeInvoker (rewritten)

```typescript
// Before: spawns child_process directly
import { spawn } from 'child_process';

export class ClaudeCodeInvoker implements AgentInvoker {
  constructor() {}
  // ... direct spawn logic
}

// After: adapter over AgentLauncher
import type { AgentLauncher } from '@generacy-ai/orchestrator';

export class ClaudeCodeInvoker implements AgentInvoker {
  constructor(private readonly agentLauncher: AgentLauncher) {}
  // ... delegates to agentLauncher.launch()
}
```

**Location**: `src/agents/claude-code-invoker.ts`

**Constructor signature change**: `new ClaudeCodeInvoker()` → `new ClaudeCodeInvoker(agentLauncher)`

## Unchanged Types

### AgentInvoker interface

```typescript
export interface AgentInvoker {
  readonly name: string;
  supports(feature: AgentFeature): boolean;
  isAvailable(): Promise<boolean>;
  initialize(): Promise<void>;
  invoke(config: InvocationConfig): Promise<InvocationResult>;
  shutdown(): Promise<void>;
}
```

**Location**: `src/agents/types.ts` — No changes.

### InvocationConfig, InvocationResult, ToolCallRecord

All unchanged. The adapter translates between these types and `LaunchRequest`/`LaunchHandle`.

### AgentRegistry

Unchanged — continues to register the adapter-form invoker.

## Type Relationships

```
InvocationConfig ──adapter──▶ LaunchRequest
     │                              │
     │                              ▼
     │                        LaunchIntent (InvokeIntent)
     │                              │
     │                              ▼
     │                  ClaudeCodeLaunchPlugin.buildLaunch()
     │                              │
     │                              ▼
     │                         LaunchSpec
     │                              │
     │                              ▼
     │                   ProcessFactory.spawn()
     │                              │
     │                              ▼
     │                     ChildProcessHandle
     │                              │
     │                              ▼
     │                        LaunchHandle
     │                              │
InvocationResult ◀──adapter──── stdout/stderr/exitPromise
```

## Validation Rules

- `InvokeIntent.command` must be a non-empty string (validated by adapter before launch)
- `InvokeIntent.kind` must be `'invoke'` (discriminant, enforced by TypeScript)
- `ClaudeCodeInvoker` constructor requires non-null `AgentLauncher` (runtime check not needed — TypeScript enforces)
