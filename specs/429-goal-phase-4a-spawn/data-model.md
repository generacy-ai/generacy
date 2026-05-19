# Data Model: Migrate SubprocessAgency to AgentLauncher

## Type Changes

### Modified: `GenericSubprocessIntent` (orchestrator)

**File**: `packages/orchestrator/src/launcher/types.ts`

```typescript
// BEFORE
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

// AFTER
export interface GenericSubprocessIntent {
  kind: 'generic-subprocess';
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: 'default' | 'interactive';  // NEW — selects ProcessFactory
}
```

**Impact**: Additive (optional field). No existing callers break.

### Unchanged: `SubprocessAgencyOptions` (generacy)

**File**: `packages/generacy/src/agency/subprocess.ts`

```typescript
// NO CHANGES — preserved exactly
export interface SubprocessAgencyOptions {
  command: string;
  args?: string[];
  logger: Logger;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
}
```

### Modified: `SubprocessAgency` constructor (generacy)

**File**: `packages/generacy/src/agency/subprocess.ts`

```typescript
// BEFORE
constructor(options: SubprocessAgencyOptions)

// AFTER — second optional parameter, NOT part of SubprocessAgencyOptions
constructor(options: SubprocessAgencyOptions, agentLauncher?: AgentLauncher)
```

### New (internal): `ProcessHandle` interface

**File**: `packages/generacy/src/agency/subprocess.ts` (not exported)

```typescript
// Internal type — covers both ChildProcess and ChildProcessHandle
interface ProcessHandle {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}
```

## Existing Types (read-only reference)

### `LaunchRequest`

```typescript
interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}
```

### `LaunchHandle`

```typescript
interface LaunchHandle {
  process: ChildProcessHandle;
  outputParser: OutputParser;
  metadata: { pluginId: string; intentKind: string; [key: string]: unknown };
}
```

### `ChildProcessHandle`

```typescript
interface ChildProcessHandle {
  stdin: NodeJS.WritableStream | null;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  pid: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  exitPromise: Promise<number | null>;
}
```

### `LaunchSpec`

```typescript
interface LaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  stdioProfile?: string;
}
```

## Data Flow

### Launcher Path

```
SubprocessAgency.connect()
  → agentLauncher.launch({
      intent: {
        kind: 'generic-subprocess',
        command: this.command,
        args: this.args,
        stdioProfile: 'interactive'   // selects ['pipe','pipe','pipe']
        // env: undefined             // omitted — no plugin-level env
      },
      cwd: this.cwd ?? process.cwd(),
      env: this.env                   // caller-level env override
    })
  → GenericSubprocessPlugin.buildLaunch(intent)
    → LaunchSpec { command, args, env: undefined, stdioProfile: 'interactive' }
  → AgentLauncher: merge env: { ...process.env, ...undefined, ...this.env }
    = { ...process.env, ...this.env }  // byte-identical to current
  → conversationProcessFactory.spawn(command, args, { cwd, env: merged })
    → stdio: ['pipe', 'pipe', 'pipe']  // matches current
  → LaunchHandle { process: ChildProcessHandle, ... }
```

### Fallback Path

```
SubprocessAgency.connect()
  → child_process.spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, ...this.env }
    })
  // Unchanged from current implementation
```

## Validation Rules

| Rule | Mechanism |
|------|-----------|
| `SubprocessAgencyOptions` unchanged | Type-level test: existing shape must be assignable |
| Env parity | Snapshot test with RecordingProcessFactory |
| Stdio parity | `stdioProfile: 'interactive'` → `['pipe','pipe','pipe']` |
| Spawn error immediate rejection | Integration test: ENOENT rejects connect(), not timeout |
| Launcher errors propagate | Unit test: mock launcher.launch() throw → connect() rejects |
