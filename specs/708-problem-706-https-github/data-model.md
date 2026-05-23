# Data Model — #708

This feature touches existing on-disk files and adds one small internal type. There is no database schema, no API surface, no new persisted entity — only the file shapes and the helper-function signatures introduced for CLI re-derivation.

## On-disk files

### `.generacy/cluster.yaml`

The authoritative source of truth for desired worker count.

**Existing schema** (`packages/generacy/src/cli/commands/cluster/context.ts:32`):

```ts
const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  appConfig: AppConfigSchema.optional(),
});
```

**Touched by this feature**:

- `worker-scaler.ts:updateClusterYaml` (existing) — writes `workers: <N>` after scale operations.
- `worker-count-deriver.ts:deriveWorkerCount` (new) — reads `workers` raw, sanitizes to a positive integer; if sanitization clamped or defaulted, re-writes `workers: 1` atomically so the file remains schema-valid for downstream `ClusterYamlSchema.parse()` consumers.

**Validation rules applied by the deriver** (FR-009, FR-010):

| Input `workers` value | Sanitized value | `source` | Side effect |
|---|---|---|---|
| Positive integer (e.g. `5`) | `5` | `'cluster.yaml'` | none |
| `0` | `1` | `'clamped'` | warn + rewrite cluster.yaml to `workers: 1` |
| Negative integer (e.g. `-2`) | `1` | `'clamped'` | warn + rewrite cluster.yaml to `workers: 1` |
| Non-integer number (e.g. `1.5`) | `1` | `'default'` | warn + rewrite cluster.yaml to `workers: 1` |
| String (e.g. `"five"`) | `1` | `'default'` | warn + rewrite cluster.yaml to `workers: 1` |
| `null` | `1` | `'default'` | warn + rewrite cluster.yaml to `workers: 1` |
| Array / object | `1` | `'default'` | warn + rewrite cluster.yaml to `workers: 1` |
| Field missing | `1` | `'default'` | warn + rewrite cluster.yaml to `workers: 1` |

### `.generacy/.env`

Compose-CLI-readable, plain-text key=value file. **Not** a schema-validated artifact — its contract is informal but documented in `scaffoldEnvFile()`.

**Relevant key**: `WORKER_COUNT=<N>` — interpolated by `docker-compose.yml` as `${WORKER_COUNT:-1}` into the worker service's `deploy.replicas`.

**Touched by this feature**:

- `worker-scaler.ts:doScale` (modified) — after `updateClusterYaml`, replaces or appends the `WORKER_COUNT=` line via `atomicWrite`. Skip-and-warn if file missing.
- `worker-count-deriver.ts:syncEnvWorkerCount` (new) — same logic, invoked from CLI before compose runs.

**File-modification invariants**:

- The write replaces the single line matching `/^WORKER_COUNT=.*$/m` with `WORKER_COUNT=<N>`.
- If no such line exists, the writer appends a `WORKER_COUNT=<N>` line at end-of-file (no preceding blank line).
- All other lines (identity vars, project vars, comments, blank lines) are preserved byte-for-byte.
- The write is atomic: temp file in the same directory, then `rename(2)` over the target.
- If the file does not exist, NO file is created. A warning is logged.

### `.generacy/docker-compose.yml`

Unchanged. The compose file already references `${WORKER_COUNT:-1}` (see `scaffolder.ts:210`); this feature does not modify the compose file.

## Internal types

### `DeriveResult` (new — `worker-count-deriver.ts`)

```ts
export interface DeriveResult {
  /** Sanitized worker count, always a positive integer. */
  workerCount: number;
  /** Where the value came from after sanitization. */
  source: 'cluster.yaml' | 'clamped' | 'default';
  /** Human-readable warnings to surface via logger. */
  warnings: string[];
}
```

### `SyncEnvResult` (new — `worker-count-deriver.ts`)

```ts
export interface SyncEnvResult {
  /** True if `.env` was modified or appended-to; false if skipped. */
  wrote: boolean;
  /** Set when `wrote === false`; identifies the skip reason. */
  reason?: 'env-missing' | 'write-failed';
  /** Set when `reason === 'write-failed'`; the original error. */
  error?: Error;
}
```

### Function signatures

```ts
// packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts

export function deriveWorkerCount(
  generacyDir: string,
  logger: Logger,
): DeriveResult;

export function syncEnvWorkerCount(
  generacyDir: string,
  workerCount: number,
  logger: Logger,
): SyncEnvResult;

export function reconcileWorkerCount(
  generacyDir: string,
  logger: Logger,
): { workerCount: number; envWrote: boolean };
```

`reconcileWorkerCount` is the high-level entry point composed by `up` and `update`:

1. Call `deriveWorkerCount(generacyDir, logger)` → log warnings.
2. If `source !== 'cluster.yaml'`, rewrite `cluster.yaml` to `workers: <workerCount>` (idempotent self-heal).
3. Call `syncEnvWorkerCount(generacyDir, workerCount, logger)` → log skip/failure reason if any.
4. Return `{ workerCount, envWrote }` for the caller's info-log.

### Modified function signatures

```ts
// packages/control-plane/src/services/worker-scaler.ts (existing function, no signature change)

async function doScale(options: ScaleOptions): Promise<ScaleResult>
```

Internally, `doScale` gains a new step after `updateClusterYaml(yamlPath, actualCount)`:

```ts
const envPath = join(generacyDir, '.env');
try {
  await syncEnvWorkerCountInScaler(envPath, actualCount);
} catch (err) {
  console.warn(`[worker-scaler] WORKER_COUNT sync to .env failed: ${err}`);
}
```

The orchestrator-side `syncEnvWorkerCountInScaler` is a private helper inside `worker-scaler.ts` — *not* a shared module with the CLI helper, because they live in different packages (orchestrator vs CLI) and the duplication is small (~20 lines). Both implementations follow the same regex pattern and the same atomicWrite contract.

## Relationships

```
                ┌──────────────────────┐
                │  cluster.yaml        │
                │  workers: N          │
                │  (source of truth)   │
                └─────────┬────────────┘
                          │ derived
                          ▼
                ┌──────────────────────┐
                │  .env                │
                │  WORKER_COUNT=N      │
                │  (compose-readable)  │
                └─────────┬────────────┘
                          │ interpolated
                          ▼
                ┌──────────────────────┐
                │  docker-compose.yml  │
                │  replicas: ${WORKER_ │
                │   COUNT:-1}          │
                └─────────┬────────────┘
                          │ executed
                          ▼
                ┌──────────────────────┐
                │  docker daemon       │
                │  N worker containers │
                └──────────────────────┘
```

**Write paths**:

- Cloud-UI scale → `worker-scaler.doScale` → writes `cluster.yaml`, then writes `.env`.
- Hand-edit → user writes `cluster.yaml` → next `npx generacy up`/`update` → `reconcileWorkerCount` → writes `.env` (and, if needed, normalizes `cluster.yaml`).

**Read paths**:

- `worker-scaler.doScale` reads neither file for the desired count — it reads the *observed* container count via Docker Engine, takes desired count from the `ScaleOptions.count` parameter, and only writes the result back to both files.
- `npx generacy up`/`update` reads `cluster.yaml` via `reconcileWorkerCount` to compute the desired `WORKER_COUNT`. `docker compose` then reads `.env` at exec time to interpolate `replicas`.

**Consistency invariant**: after any successful invocation of either write path, `cluster.yaml.workers === .env.WORKER_COUNT` modulo the partial-failure window (worker-scaler.yaml-success-then-env-failure), which is self-healed on the next `up`/`update`.
