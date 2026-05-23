# Data Model

## File contracts

### `.generacy/cluster.yaml` (git-tracked, template-owned)

Source-of-truth launch defaults shipped in the cluster-base / cluster-microservices template. Treated as **read-only at runtime** by writers introduced in this PR. (Other currently-mutating writers — `appConfig.*` — are out of scope and continue to write here pending the follow-up PR.)

```yaml
# Example (current shape, unchanged by this PR)
channel: stable          # 'preview' | 'stable'
workers: 1               # integer >= 1 — template default; runtime override lives in cluster.local.yaml
variant: cluster-base    # 'cluster-base' | 'cluster-microservices'
appConfig:               # optional, nested; mutated by app-config routes (out of scope here)
  env: [...]
  files: [...]
  secrets: [...]
```

### `.generacy/cluster.local.yaml` (git-ignored, runtime-owned) — NEW

Per-cluster runtime state. Written by orchestrator/control-plane processes; never committed to the user's repo. Created on first scale; persists across container restarts via the same volume that hosts `.generacy/`.

```yaml
# Initial shape (this PR)
workers: 3               # integer >= 1 — overrides cluster.yaml workers via local-wins

# Reserved/extensible shape (future fields drop in without further structural change)
# channel: preview       # future, when channel switching becomes runtime-mutable
# appConfig: ...         # future, after deep-merge follow-up lands
```

The file may be entirely absent — readers handle ENOENT as `{}` and return the canonical-only view.

## Types

### `MergedClusterConfig` — NEW (in `@generacy-ai/config`)

```typescript
export interface MergedClusterConfig {
  /** Shallow per-top-level-key merge: cluster.local.yaml wins per key. */
  merged: ClusterYamlData;
  /** Raw parsed `cluster.yaml`, or `{}` if missing. */
  canonical: ClusterYamlData;
  /** Raw parsed `cluster.local.yaml`, or `{}` if missing. */
  local: ClusterLocalYamlData;
}
```

### `ClusterYamlData` — NEW

Permissive Zod-validated shape of `cluster.yaml`. All fields optional so partial files (template-default-only, or `appConfig`-only) parse cleanly.

```typescript
export const ClusterYamlSchema = z
  .object({
    channel: z.enum(['preview', 'stable']).optional(),
    workers: z.number().int().min(1).optional(),
    variant: z.enum(['cluster-base', 'cluster-microservices']).optional(),
    // appConfig is re-parsed by app-config route with its own schema;
    // helper just passes the raw block through.
    appConfig: z.unknown().optional(),
  })
  .passthrough();

export type ClusterYamlData = z.infer<typeof ClusterYamlSchema>;
```

### `ClusterLocalYamlData` — NEW

Currently a strict subset (`workers` only) but the schema uses `.passthrough()` so additions don't need a schema change in this PR. When a future PR adds a new runtime-mutable field, this schema tightens to include it.

```typescript
export const ClusterLocalYamlSchema = z
  .object({
    workers: z.number().int().min(1).optional(),
  })
  .passthrough();

export type ClusterLocalYamlData = z.infer<typeof ClusterLocalYamlSchema>;
```

## API

### `readMergedClusterConfig(generacyDir)` — NEW

```typescript
/**
 * Read .generacy/cluster.yaml and .generacy/cluster.local.yaml, returning the
 * shallow-merged view (local wins per top-level key) plus each raw form.
 *
 * - ENOENT on either file → empty object.
 * - Malformed YAML on either file → throw (fail loud).
 * - Both files missing → all three returned fields are {}.
 */
export async function readMergedClusterConfig(
  generacyDir: string,
): Promise<MergedClusterConfig>;
```

Path resolution is left to the caller — pass an absolute or CWD-relative `.generacy/` directory. (Worker-scaler and app-config use `resolveGeneracyDir()`; relay-bridge derives from `dirname(config.clusterYamlPath)`.)

### `updateClusterLocalYaml(localYamlPath, count)` — NEW (in `worker-scaler.ts`)

```typescript
/**
 * Update the `workers` field in cluster.local.yaml atomically.
 * Creates the file if absent. Preserves any other fields already present.
 */
async function updateClusterLocalYaml(localYamlPath: string, count: number): Promise<void>;
```

Internal to `worker-scaler.ts`. Mirrors the existing `updateClusterYaml` (temp+rename atomic write, permissive YAML parse with empty-doc fallback). The existing `updateClusterYaml` export is **removed** in the same PR — no callers remain after the migration.

## Merge semantics (shallow per top-level key)

For each key K appearing in `canonical` or `local`:
- If K in `local`: `merged[K] = local[K]`.
- Else: `merged[K] = canonical[K]`.

Nested objects are replaced wholesale, not merged. For this PR that's fine — only `workers` (a flat number) is moved. Deep-merge is filed as a follow-up alongside the first nested-field migration.

```text
canonical: { workers: 1, channel: stable, variant: cluster-base, appConfig: {...} }
local:     { workers: 3 }
merged:    { workers: 3, channel: stable, variant: cluster-base, appConfig: {...} }
```

## Validation rules

| Field | Rule | Enforced where |
|-------|------|----------------|
| `cluster.yaml workers` | integer >= 1 (when present) | `ClusterYamlSchema` |
| `cluster.local.yaml workers` | integer >= 1 (when present) | `ClusterLocalYamlSchema` |
| `cluster.yaml channel` | `'preview' \| 'stable'` (when present) | `ClusterYamlSchema` |
| `cluster.yaml variant` | `'cluster-base' \| 'cluster-microservices'` (when present) | `ClusterYamlSchema` |
| `appConfig` block | passed through as unknown; re-parsed by `app-config.ts` with `AppConfigSchema` | caller |
| Both files | malformed YAML throws (does not silently fall through to the other) | helper |

## Relationships

```text
.generacy/
├── cluster.yaml         (template-owned, git-tracked)
│   └── read by ──────────────► readMergedClusterConfig.canonical
└── cluster.local.yaml   (runtime-owned, git-ignored)   [NEW]
    ├── written by ──────────► worker-scaler.updateClusterLocalYaml
    └── read by ──────────────► readMergedClusterConfig.local

readMergedClusterConfig
├── consumed by ─────────────► worker-scaler.ts          (already reads via update path)
├── consumed by ─────────────► relay-bridge.readClusterYaml
└── consumed by ─────────────► app-config.readManifest
```

## State transitions

- **First scale on a clean project**: `cluster.local.yaml` does not exist → `enumerateWorkers()` reads count from Docker, helper merge returns canonical defaults → write creates `cluster.local.yaml` with `workers: <newCount>`.
- **Subsequent scale**: `cluster.local.yaml` exists with previous count → atomic update sets new count.
- **Manual delete of `cluster.local.yaml`**: next read returns canonical-only view (template default `workers: 1`). Next scale recreates the file.
- **Pre-fix project with mutated `cluster.yaml workers:`**: first post-fix scale leaves `cluster.yaml` untouched, creates `cluster.local.yaml` with new count. Effective count = local. Stale canonical value is documentation noise only.
