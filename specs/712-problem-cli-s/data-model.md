# Data Model: CLI worker-count-deriver

**Issue**: [#712](https://github.com/generacy-ai/generacy/issues/712)
**Branch**: `712-problem-cli-s`

## Entities

### `DeriveResult` (modified)

The return shape of `deriveWorkerCount(generacyDir, logger)`.

```ts
export interface DeriveResult {
  workerCount: number;            // always >= 1; clamped if input was 0 or negative
  source:
    | 'cluster.yaml'              // merged value came from canonical layer (local absent or degraded)
    | 'cluster.local.yaml'        // merged value came from overlay (local-wins)
    | 'clamped'                   // numeric input was <1; coerced to 1
    | 'default';                  // no usable value found anywhere; coerced to 1
  warnings: string[];             // human-readable; emitted via `logger.warn` by callers
}
```

**Validation rules**:
- `workerCount`: integer >= 1. Anything ≤ 0 from input becomes `1` with `source: 'clamped'`. Non-integer numerics (e.g. `1.5`) become `1` with `source: 'default'` and a "malformed" warning.
- `source`: discriminated string. Tests and log messages branch on it; no other code reads it.
- `warnings`: zero or more strings. Concatenated for logging; not parsed.

**Relationships**:
- Consumed only by `reconcileWorkerCount` (same file) and tests.
- Not exported to any other package.

### `MergedClusterConfig` (imported, unchanged)

From `@generacy-ai/config`. Re-stated here for cross-reference.

```ts
export interface MergedClusterConfig {
  merged: ClusterYamlData;     // shallow merge: { ...canonical, ...local }
  canonical: ClusterYamlData;  // raw parsed cluster.yaml, or {}
  local: ClusterLocalYamlData; // raw parsed cluster.local.yaml, or {}
}
```

**Validation rules** (enforced by `readMergedClusterConfig`):
- ENOENT on either file → that field is `{}`.
- Malformed YAML on either file → throws `Error('Failed to parse YAML at <path>: ...')`.
- Schema-rejection by `ClusterYamlSchema` / `ClusterLocalYamlSchema` → throws.

**Relationships**:
- Imported by the deriver via `import { readMergedClusterConfig } from '@generacy-ai/config'`.
- Source of truth for the new merged-read code path.

### `ClusterLocalYamlData` (imported, unchanged)

```ts
export const ClusterLocalYamlSchema = z
  .object({
    workers: z.number().int().min(1).optional(),
  })
  .passthrough();
```

**Validation rules**:
- `workers`, if present, must be an integer >= 1. Anything else (string, `0`, `-3`, `1.5`) makes the schema throw on the merged read; the deriver's degraded-read fallback catches this.

### `SyncEnvResult` (unchanged)

The return shape of `syncEnvWorkerCount(generacyDir, workerCount, logger)`. Already exists; no changes.

```ts
export interface SyncEnvResult {
  wrote: boolean;
  reason?: 'env-missing' | 'write-failed';
  error?: Error;
}
```

### Source enum semantics

```text
'cluster.yaml'        merged.workers came from canonical layer ONLY
                      (local was absent OR local was unreadable and we fell back)

'cluster.local.yaml'  merged.workers came from overlay
                      (overlay-wins took effect, OR canonical was missing but overlay supplied)

'clamped'             numeric value found but ≤ 0; output forced to 1
                      (warning carries the original value)

'default'             no usable numeric value anywhere; output forced to 1
                      (warning explains why: missing key / malformed type / both files missing)
```

## Behavioral matrix (canonical reference)

From `clarifications.md`, reproduced here for code/tests:

| canonical                  | local                     | workerCount | source                | warnings                              |
|----------------------------|---------------------------|-------------|-----------------------|---------------------------------------|
| present, valid (e.g. 3)    | absent                    | 3           | `cluster.yaml`        | —                                     |
| present, valid (3)         | present, valid (5)        | 5           | `cluster.local.yaml`  | —                                     |
| present, valid (3)         | present, malformed        | 3           | `cluster.yaml`        | "cluster.local.yaml unreadable; using cluster.yaml value" |
| absent                     | present, valid (5)        | 5           | `cluster.local.yaml`  | "cluster.yaml not found … run `npx generacy init`" |
| absent                     | absent                    | 1           | `default`             | "both files missing"                  |
| present, malformed         | absent                    | 1           | `default`             | "canonical malformed"                 |
| present, malformed         | present, valid (5)        | 5           | `cluster.local.yaml`  | "canonical malformed"                 |
| any value yielding ≤0      | any                       | 1           | `clamped`             | "clamping to 1"                       |

## Relationships

```text
up/index.ts ─────┐
update/index.ts ─┴──► reconcileWorkerCount(dir, logger)
                          │
                          ├──► deriveWorkerCount(dir, logger)  ── async
                          │       │
                          │       └──► readMergedClusterConfig(dir)  ── from @generacy-ai/config
                          │              │
                          │              ├── readAndParse(cluster.yaml, ClusterYamlSchema)
                          │              └── readAndParse(cluster.local.yaml, ClusterLocalYamlSchema)
                          │
                          └──► syncEnvWorkerCount(dir, workerCount, logger)
                                  │
                                  └── writes WORKER_COUNT line into .generacy/.env
```

The write-back branch from `reconcileWorkerCount` → `atomicWriteSync(cluster.yaml)` is removed in this feature.
