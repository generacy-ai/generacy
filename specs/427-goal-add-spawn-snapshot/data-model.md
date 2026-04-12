# Data Model: Spawn Snapshot Test Harness

## Core Entities

### SpawnRecord

Represents a single recorded `ProcessFactory.spawn()` call. Captures exactly the arguments the spawner passes — nothing more.

```typescript
export interface SpawnRecord {
  /** The executable command (e.g., 'claude', 'sh') */
  command: string;
  /** The argument array passed to spawn */
  args: string[];
  /** The working directory */
  cwd: string;
  /** The environment variable overrides (NOT the full merged env) */
  env: Record<string, string>;
}
```

**Design notes**:
- No `stdio` field — not part of `ProcessFactory` interface (clarification Q1, option A)
- No `uid`/`gid` — not part of `ProcessFactory` interface
- No `signal` — `AbortSignal` is a control mechanism, not a spawn configuration property; not serializable
- `env` contains only the override set passed by the spawner, not the full `process.env` merge (clarification Q2, option A)

### RecordingProcessFactory

Implements `ProcessFactory`. Accumulates `SpawnRecord[]` and returns dummy `ChildProcessHandle` instances.

```typescript
export class RecordingProcessFactory implements ProcessFactory {
  /** All recorded spawn calls, in order */
  readonly calls: SpawnRecord[];

  /** The exit code that dummy processes will resolve with */
  constructor(exitCode?: number);

  /** Records the call and returns a dummy ChildProcessHandle */
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle;

  /** Resets the calls array */
  reset(): void;
}
```

### Dummy ChildProcessHandle

Returned by `RecordingProcessFactory.spawn()`. Satisfies the `ChildProcessHandle` interface with inert implementations.

| Field | Value | Notes |
|-------|-------|-------|
| `stdin` | `null` | Matches worker factory behavior |
| `stdout` | `new EventEmitter()` | Cast to `NodeJS.ReadableStream`; emits no data |
| `stderr` | `new EventEmitter()` | Cast to `NodeJS.ReadableStream`; emits no data |
| `pid` | `12345` | Deterministic, matches existing test convention |
| `kill()` | Returns `true`, resolves `exitPromise` | Immediate resolution on SIGTERM/SIGKILL |
| `exitPromise` | `Promise<0>` (or configured exit code) | Resolves after microtask |

## Relationships

```
CliSpawner ──uses──▶ ProcessFactory (interface)
                          │
                ┌─────────┼──────────┐
                ▼         ▼          ▼
        Worker Factory  Conv Factory  RecordingProcessFactory
        (production)    (production)  (test utility)
                                        │
                                        ├── calls: SpawnRecord[]
                                        └── returns: dummy ChildProcessHandle
```

## Validation Rules

- `SpawnRecord.command` must be a non-empty string
- `SpawnRecord.args` is the raw array — no validation (tests assert exact values)
- `SpawnRecord.env` keys are sorted alphabetically by `normalizeSpawnRecords()` before snapshot comparison
- `RecordingProcessFactory.exitCode` defaults to `0` if not provided
