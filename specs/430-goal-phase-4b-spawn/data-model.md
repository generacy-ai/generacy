# Data Model: Phase 4b — executeCommand / executeShellCommand Migration

## New Types (workflow-engine)

### LaunchFunctionRequest

Request object passed to the registered launcher. Defined locally in `workflow-engine` — no dependency on `orchestrator` types.

```typescript
/** Describes what to spawn via the registered process launcher */
export interface LaunchFunctionRequest {
  /** Intent kind: 'generic-subprocess' for command+args, 'shell' for shell command string */
  kind: 'generic-subprocess' | 'shell';
  /** Command to execute */
  command: string;
  /** Command arguments (empty for shell kind) */
  args: string[];
  /** Working directory */
  cwd: string;
  /** Environment variable overrides */
  env?: Record<string, string>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Whether to create a process group (enables group-kill) */
  detached?: boolean;
}
```

### LaunchFunctionHandle

Minimal handle returned by the launcher. Mirrors the subset of `ChildProcessHandle` that `executeCommand`/`executeShellCommand` actually use.

```typescript
/** Handle returned by the registered process launcher */
export interface LaunchFunctionHandle {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  exitPromise: Promise<number | null>;
}
```

### LaunchFunction

```typescript
/** Function type for the module-level process launcher registration */
export type LaunchFunction = (request: LaunchFunctionRequest) => LaunchFunctionHandle;
```

### Registration API

```typescript
/** Register a process launcher (called once at orchestrator boot) */
export function registerProcessLauncher(launcher: LaunchFunction): void;

/** Get the registered process launcher (undefined if not registered) */
export function getProcessLauncher(): LaunchFunction | undefined;

/** Clear registration (for testing) */
export function clearProcessLauncher(): void;
```

## Modified Types (orchestrator)

### ProcessFactory.spawn options — add `detached`

```typescript
// worker/types.ts — ProcessFactory interface
interface ProcessFactory {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      uid?: number;
      gid?: number;
      detached?: boolean;  // NEW — create process group
    },
  ): ChildProcessHandle;
}
```

### LaunchSpec — add `detached`

```typescript
// launcher/types.ts — LaunchSpec interface
interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: string;
  detached?: boolean;  // NEW — forwarded from intent
}
```

### LaunchRequest — add `detached`

```typescript
// launcher/types.ts — LaunchRequest interface
interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;  // NEW — forwarded to factory
}
```

### GenericSubprocessIntent / ShellIntent — add `detached`

```typescript
interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
  detached?: boolean;  // NEW
}

interface ShellIntent {
  kind: 'shell';
  command: string;
  env?: Record<string, string>;
  detached?: boolean;  // NEW
}
```

### SpawnRecord — add `detached`

```typescript
// test-utils/recording-process-factory.ts
interface SpawnRecord {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  detached?: boolean;  // NEW — captured for snapshot tests
}
```

## Preserved Types (no changes)

| Type | Package | Notes |
|------|---------|-------|
| `CommandOptions` | workflow-engine | Public API — unchanged |
| `CommandResult` | workflow-engine | Public API — unchanged |
| `CLIStatus` | workflow-engine | Unchanged |
| `ChildProcessHandle` | orchestrator | Already exposes `.pid` — sufficient for group-kill |
| `AgentLaunchPlugin` | orchestrator | Unchanged |
| `OutputParser` | orchestrator | Unchanged |
| `LaunchHandle` | orchestrator | Unchanged |

## Relationships

```
orchestrator boot
  └── registerProcessLauncher(adapter)
        │
        ▼
workflow-engine (module-level)
  ├── _registeredLauncher: LaunchFunction | undefined
  │
  ├── executeCommand(command, args, options)
  │     ├── if _registeredLauncher → LaunchFunctionRequest { kind: 'generic-subprocess', detached: true }
  │     └── else → direct child_process.spawn (fallback)
  │
  └── executeShellCommand(command, options)
        ├── if _registeredLauncher → LaunchFunctionRequest { kind: 'shell', detached: true }
        └── else → direct child_process.spawn (fallback)

orchestrator adapter (at registration time):
  LaunchFunction → AgentLauncher.launch(LaunchRequest) → ProcessFactory.spawn(detached) → ChildProcessHandle
```

## Validation Rules

- `registerProcessLauncher()` must be idempotent or throw on double-registration (TBD — recommend throw, matching `AgentLauncher.registerPlugin()` behavior)
- `clearProcessLauncher()` only used in tests — not exported from public API
- `detached` defaults to `false` / `undefined` in all interfaces — only `executeCommand` / `executeShellCommand` explicitly set `detached: true`
