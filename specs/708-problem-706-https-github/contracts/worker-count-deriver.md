# Contract — `worker-count-deriver` module

## Module location

`packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts`

## Public exports

### `deriveWorkerCount`

```ts
export function deriveWorkerCount(
  generacyDir: string,
  logger: Logger,
): DeriveResult;
```

**Inputs**:
- `generacyDir` — absolute path to the `.generacy/` directory containing `cluster.yaml`.
- `logger` — pino-shaped logger (from `getLogger()`).

**Returns**:
```ts
interface DeriveResult {
  workerCount: number;          // always >= 1
  source: 'cluster.yaml' | 'clamped' | 'default';
  warnings: string[];
}
```

**Behavior**:
1. Read `<generacyDir>/cluster.yaml`. If missing or unreadable, return `{ workerCount: 1, source: 'default', warnings: [<reason>] }`.
2. Parse as YAML. Inspect the `workers` field as `unknown`.
3. If positive integer → `{ workerCount: <value>, source: 'cluster.yaml', warnings: [] }`.
4. If `0` or negative integer → `{ workerCount: 1, source: 'clamped', warnings: [<message>] }`.
5. Else (string, null, array, object, non-integer number, missing) → `{ workerCount: 1, source: 'default', warnings: [<message>] }`.

**Side effects**: none (pure read). Warnings are returned, not logged inside this function — the caller decides whether to log.

### `syncEnvWorkerCount`

```ts
export function syncEnvWorkerCount(
  generacyDir: string,
  workerCount: number,
  logger: Logger,
): SyncEnvResult;
```

**Inputs**:
- `generacyDir` — absolute path to `.generacy/`.
- `workerCount` — positive integer to write.
- `logger` — used for the skip-warning path.

**Returns**:
```ts
interface SyncEnvResult {
  wrote: boolean;
  reason?: 'env-missing' | 'write-failed';
  error?: Error;
}
```

**Behavior**:
1. Check for `<generacyDir>/.env`. If missing, log warning, return `{ wrote: false, reason: 'env-missing' }`.
2. Read existing content. Replace the line matching `/^WORKER_COUNT=.*$/m` with `WORKER_COUNT=<workerCount>`. If no match, append the line.
3. Write atomically (temp + rename). On success, return `{ wrote: true }`. On failure, log warning and return `{ wrote: false, reason: 'write-failed', error }`.

**Side effects**: writes `.env` (atomic) and emits log warnings on the failure paths. Never throws — all failures are returned via the result object.

### `reconcileWorkerCount`

```ts
export function reconcileWorkerCount(
  generacyDir: string,
  logger: Logger,
): { workerCount: number; envWrote: boolean };
```

**Inputs**: same as `deriveWorkerCount`.

**Returns**:
```ts
{
  workerCount: number;   // sanitized count actually written to .env (or that would have been)
  envWrote: boolean;     // whether .env was successfully updated
}
```

**Behavior** (composed):
1. Call `deriveWorkerCount(generacyDir, logger)`. Log each warning via `logger.warn(...)`.
2. If `source !== 'cluster.yaml'`, atomically rewrite `<generacyDir>/cluster.yaml` to set `workers: <workerCount>`. Log an info message identifying the rewrite. On rewrite failure, log warning and continue (non-fatal).
3. Call `syncEnvWorkerCount(generacyDir, workerCount, logger)`. Use its `wrote` field for the returned `envWrote`.
4. If `envWrote` is true, log a single info-level message: `Reconciled WORKER_COUNT from cluster.yaml: <workerCount>`.

**Side effects**: may write `cluster.yaml` and `.env`. Emits log messages. Never throws.

## Invariants

1. `deriveWorkerCount` always returns a positive integer in `workerCount`.
2. `syncEnvWorkerCount` never creates a new `.env` file. Missing `.env` → `wrote: false, reason: 'env-missing'`.
3. `reconcileWorkerCount` is idempotent: running it twice in a row with no intervening edits yields the same state on disk and `envWrote: true` on the first call, `envWrote: true` on the second (with the file content unchanged byte-for-byte).
4. `reconcileWorkerCount` does not depend on `getClusterContext()` and does not throw on edge-case `cluster.yaml` values that would crash `ClusterYamlSchema.parse()`. It must be safe to call BEFORE `getClusterContext()` in command flows.
5. None of the three functions issue network or Docker calls.

## Test obligations

Each public export has an entry in `worker-count-deriver.test.ts` covering at minimum:

- `deriveWorkerCount`: positive integer, 0, negative integer, non-integer number, string, null, array, missing key, missing file, unreadable file.
- `syncEnvWorkerCount`: in-place replace, append, missing file (skip), write error.
- `reconcileWorkerCount`: integration of the above with the cluster.yaml self-heal step.

## Stability

This module is internal to the `generacy` CLI package. It has no published API surface and may change shape in subsequent issues without semver implications.
