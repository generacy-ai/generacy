# Data Model: Migrate pr-feedback-handler to AgentLauncher

**Feature**: #432 — Phase 3b Spawn Refactor
**Date**: 2026-04-12

## Core Interfaces

### PrFeedbackIntent (existing — no changes)

```typescript
// packages/generacy-plugin-claude-code/src/launch/types.ts
export interface PrFeedbackIntent {
  kind: 'pr-feedback';
  prNumber: number;     // PR number for logging/tracing
  prompt: string;       // Pre-built prompt string
}
```

### LaunchRequest (existing — no changes)

```typescript
// packages/orchestrator/src/launcher/agent-launcher.ts
interface LaunchRequest {
  intent: AgentIntent;  // Plugin-specific intent (PrFeedbackIntent for this migration)
  cwd: string;          // Working directory for the spawned process
  env?: Record<string, string>;  // Caller-layer env overrides
  signal?: AbortSignal;  // Optional abort signal
}
```

### LaunchHandle (existing — no changes)

```typescript
// packages/orchestrator/src/launcher/agent-launcher.ts
interface LaunchHandle {
  process: ChildProcessHandle;  // The spawned process — identical to processFactory.spawn() return
  outputParser: OutputParser;    // No-op for ClaudeCodeLaunchPlugin
  metadata: {
    pluginId: string;      // 'claude-code'
    intentKind: string;    // 'pr-feedback'
    [key: string]: unknown;
  };
}
```

### ChildProcessHandle (existing — no changes)

```typescript
// packages/orchestrator/src/process/types.ts
interface ChildProcessHandle {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  pid: number;
  exitPromise: Promise<{ code: number | null; signal: string | null }>;
  kill(signal?: string): void;
}
```

### LaunchSpec (existing — no changes)

```typescript
// packages/orchestrator/src/launcher/agent-launcher.ts
interface LaunchSpec {
  command: string;       // 'claude'
  args: string[];        // ['-p', '--output-format', 'stream-json', ...]
  env?: Record<string, string>;  // Plugin-layer env
  stdioProfile: 'default' | 'interactive';  // 'default' for pr-feedback
}
```

## Type Flow

```
PrFeedbackHandler
  ├── Constructs PrFeedbackIntent { kind: 'pr-feedback', prNumber, prompt }
  ├── Calls agentLauncher.launch({ intent, cwd, env: {} })
  │     ├── AgentLauncher resolves ClaudeCodeLaunchPlugin (by intent.kind)
  │     ├── Plugin.buildLaunch() returns LaunchSpec { command: 'claude', args: [...], stdioProfile: 'default' }
  │     ├── AgentLauncher merges env: process.env ← plugin.env ← caller.env
  │     ├── AgentLauncher spawns via processFactory.spawn(command, args, { cwd, env })
  │     └── Returns LaunchHandle { process, outputParser, metadata }
  └── Uses handle.process (ChildProcessHandle) for:
        ├── stdout.on('data') → OutputCapture
        ├── stderr.on('data') → buffer
        ├── kill('SIGTERM') → timeout handling
        └── exitPromise → completion
```

## Validation Rules

- `intent.kind` must be `'pr-feedback'` (type-enforced)
- `intent.prompt` must be a non-empty string (constructed by handler before launch)
- `intent.prNumber` must be a positive integer (passed from job context)
- `cwd` must be a valid checkout path (validated upstream by RepoCheckout)

## Relationships

```
ClaudeCliWorker ──creates──> AgentLauncher ──registered──> ClaudeCodeLaunchPlugin
     │                            │
     └──creates──> PrFeedbackHandler ──calls──> agentLauncher.launch()
                        │                              │
                        │                              └──returns──> LaunchHandle
                        │                                                │
                        └──uses──> handle.process (ChildProcessHandle) ──> stdout/stderr/signals
```

No new types or interfaces are introduced. The migration reuses all existing types.
