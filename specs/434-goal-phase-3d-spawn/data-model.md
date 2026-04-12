# Data Model: Migrate cli-spawner shell validators to AgentLauncher

## Type Changes

### CliSpawner constructor signature

**Before:**
```typescript
constructor(
  private readonly processFactory: ProcessFactory,
  private readonly logger: Logger,
  private readonly shutdownGracePeriodMs: number = 5000,
)
```

**After:**
```typescript
constructor(
  private readonly processFactory: ProcessFactory,
  private readonly logger: Logger,
  private readonly shutdownGracePeriodMs: number = 5000,
  private readonly agentLauncher?: AgentLauncher,
)
```

## Existing Types (read-only, no changes)

### ShellIntent (from `launcher/types.ts`)

```typescript
interface ShellIntent {
  kind: 'shell';
  command: string;
  env?: Record<string, string>;
  detached?: boolean;
}
```

### LaunchRequest (from `launcher/types.ts`)

```typescript
interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
}
```

### LaunchHandle (from `launcher/types.ts`)

```typescript
interface LaunchHandle {
  process: ChildProcessHandle;
  outputParser: OutputParser;
  metadata: {
    pluginId: string;
    intentKind: string;
    [key: string]: unknown;
  };
}
```

### ChildProcessHandle (from `worker/types.ts`)

```typescript
interface ChildProcessHandle {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid: number | undefined;
  kill(signal?: string): boolean;
  exitPromise: Promise<number>;
}
```

## Relationships

```
CliSpawner
  ├── processFactory: ProcessFactory    (existing, retained for spawnPhase)
  ├── agentLauncher?: AgentLauncher     (NEW, optional)
  │     └── launch(LaunchRequest) → LaunchHandle
  │           ├── .process: ChildProcessHandle  ──→ passed to manageProcess()
  │           └── .outputParser: OutputParser    ──→ unused (validators don't parse output)
  └── manageProcess(child, phase, ...) → PhaseResult  (unchanged)
```

## Validation Rules

- `agentLauncher` is optional — when absent, falls back to direct `processFactory.spawn`
- `intent.kind` must be `'shell'` for validator spawn sites
- `intent.command` must be non-empty string (the validate/install command)
- `cwd` is required and must match `checkoutPath` parameter
