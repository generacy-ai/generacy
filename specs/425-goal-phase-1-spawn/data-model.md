# Data Model: AgentLauncher + GenericSubprocessPlugin (Phase 1)

**Feature**: #425 | **Date**: 2026-04-12

All types defined in `packages/orchestrator/src/launcher/types.ts`.

## Core Types

### LaunchIntent (Discriminated Union)

```typescript
/**
 * Intent for launching a generic subprocess with explicit command/args.
 */
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Intent for launching a shell command (string passed to sh -c).
 */
export interface ShellIntent {
  kind: 'shell';
  command: string;  // Shell command string (passed to sh -c)
  env?: Record<string, string>;
}

/**
 * Discriminated union of all launch intent kinds.
 * Phase 1: generic-subprocess, shell
 * Future waves add: phase, pr-feedback, conversation-turn
 */
export type LaunchIntent = GenericSubprocessIntent | ShellIntent;
```

**Extensibility**: New intent kinds are added by defining a new interface and adding it to the union. TypeScript narrows via `intent.kind`.

### LaunchRequest

```typescript
/**
 * Request to launch a process through the AgentLauncher.
 */
export interface LaunchRequest {
  /** The intent describing what to launch */
  intent: LaunchIntent;
  /** Working directory for the spawned process */
  cwd: string;
  /** Caller-provided environment overrides (highest priority in merge) */
  env?: Record<string, string>;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
}
```

### LaunchSpec (Plugin Output)

```typescript
/**
 * Output of a plugin's buildLaunch() — tells the launcher HOW to spawn.
 */
export interface LaunchSpec {
  /** Executable command */
  command: string;
  /** Command arguments */
  args: string[];
  /** Plugin-provided environment variables (middle priority in merge) */
  env?: Record<string, string>;
  /**
   * Stdio profile name selecting which ProcessFactory to use.
   * Default: "default" (stdin ignored, stdout/stderr piped)
   * "interactive" selects the conversation factory (all stdio piped)
   */
  stdioProfile?: string;
}
```

### AgentLaunchPlugin (Interface)

```typescript
/**
 * Plugin interface for the AgentLauncher registry.
 * Each plugin handles one or more LaunchIntent kinds.
 */
export interface AgentLaunchPlugin {
  /** Unique identifier for this plugin */
  readonly pluginId: string;
  /** Intent kinds this plugin can handle */
  readonly supportedKinds: readonly string[];
  /**
   * Transform a LaunchIntent into a LaunchSpec (command, args, env, stdio profile).
   * Called by AgentLauncher during launch().
   */
  buildLaunch(intent: LaunchIntent): LaunchSpec;
  /**
   * Create a new OutputParser instance for this launch.
   * Called once per launch; the parser is attached to the LaunchHandle.
   */
  createOutputParser(): OutputParser;
}
```

### OutputParser (Interface)

```typescript
/**
 * Stateful output parser attached to a launched process.
 * Processes chunks from stdout/stderr streams.
 */
export interface OutputParser {
  /**
   * Process a chunk of output from the child process.
   * @param stream - Which stream the data came from
   * @param data - The string data chunk
   */
  processChunk(stream: 'stdout' | 'stderr', data: string): void;
  /**
   * Flush any buffered state. Called when the process exits.
   */
  flush(): void;
}
```

### LaunchHandle (Return Type)

```typescript
import type { ChildProcessHandle } from '../worker/types.js';

/**
 * Handle returned by AgentLauncher.launch().
 * Thin wrapper — no lifecycle ownership (callers manage shutdown).
 */
export interface LaunchHandle {
  /** The underlying child process handle (kill, exitPromise, stdio streams) */
  process: ChildProcessHandle;
  /** Plugin-created output parser for this launch */
  outputParser: OutputParser;
  /** Plugin-provided metadata (e.g., plugin ID, intent kind) */
  metadata: {
    pluginId: string;
    intentKind: string;
    [key: string]: unknown;
  };
}
```

## Relationships

```
LaunchRequest ──contains──> LaunchIntent (discriminated union)
     │
     ▼
AgentLauncher.launch()
     │
     ├── resolves ──> AgentLaunchPlugin (via kind → plugin map)
     │                    │
     │                    ├── buildLaunch(intent) ──> LaunchSpec
     │                    └── createOutputParser() ──> OutputParser
     │
     ├── merges env: process.env ← LaunchSpec.env ← LaunchRequest.env
     │
     ├── selects ──> ProcessFactory (via LaunchSpec.stdioProfile)
     │                    │
     │                    └── spawn() ──> ChildProcessHandle
     │
     └── returns ──> LaunchHandle
                         ├── process: ChildProcessHandle
                         ├── outputParser: OutputParser
                         └── metadata: { pluginId, intentKind }
```

## Existing Types Reused (No Changes)

| Type | Location | Usage |
|------|----------|-------|
| `ProcessFactory` | `src/worker/types.ts:269` | Factory interface for spawning — selected by stdio profile |
| `ChildProcessHandle` | `src/worker/types.ts:280` | Wrapped inside `LaunchHandle.process` |

## Validation Rules

| Rule | Enforcement |
|------|-------------|
| `LaunchIntent.kind` must match a registered plugin | Runtime: `AgentLauncher.launch()` throws if no plugin registered for the kind |
| `LaunchSpec.stdioProfile` must match a registered factory | Runtime: `AgentLauncher.launch()` throws if profile not in factory map |
| No duplicate kind registrations | Runtime: `AgentLauncher.registerPlugin()` throws on duplicate |
| `LaunchRequest.cwd` must be provided | Compile-time: required field in interface |
| `LaunchRequest.intent` must be a valid `LaunchIntent` | Compile-time: TypeScript discriminated union |

## GenericSubprocessPlugin Behavior

### `buildLaunch()` mapping

| Intent Kind | Output `LaunchSpec` |
|-------------|-------------------|
| `generic-subprocess` | `{ command: intent.command, args: intent.args, env: intent.env, stdioProfile: "default" }` |
| `shell` | `{ command: "sh", args: ["-c", intent.command], env: intent.env, stdioProfile: "default" }` |

### `createOutputParser()` output

Returns a no-op `OutputParser`:
```typescript
{
  processChunk(_stream, _data) { /* no-op */ },
  flush() { /* no-op */ },
}
```
