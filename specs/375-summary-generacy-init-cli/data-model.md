# Data Model: Refactor generacy init to use cluster-base repos

## Modified Types

### `template-fetcher.ts` — New Constants

```typescript
/**
 * Maps each cluster variant to its dedicated GitHub repository.
 * Replaces the single `REPO = 'generacy-ai/cluster-templates'` constant.
 */
const VARIANT_REPOS: Record<ClusterVariant, string> = {
  standard: 'generacy-ai/cluster-base',
  microservices: 'generacy-ai/cluster-microservices',
};

/** Default git ref for base repos (changed from 'develop' to 'main'). */
const DEFAULT_REF = 'main';
```

### `FetchOptions` — No Structural Change

```typescript
export interface FetchOptions {
  variant: ClusterVariant;      // Unchanged — still selects which repo to fetch
  ref?: string;                 // Unchanged — but default changes from 'develop' to 'main'
  token?: string | null;        // Unchanged
  refreshCache?: boolean;       // Unchanged
}
```

The interface shape is unchanged. Only the runtime default for `ref` changes.

### `InitOptions` — No Structural Change

```typescript
interface InitOptions {
  // ... all fields unchanged
  templateRef: string;          // Kept as-is (not renamed to baseRef)
  refreshTemplates: boolean;    // Kept as-is
}
```

### `ClusterVariant` — No Change

```typescript
type ClusterVariant = 'standard' | 'microservices';
```

## Cache Structure

### Before

```
~/.generacy/template-cache/
└── {ref}/                    # e.g., 'develop'
    └── {variant}/            # e.g., 'standard'
        └── .devcontainer/
            ├── Dockerfile
            └── ...
```

### After

```
~/.generacy/template-cache/
└── {repo-name}/              # e.g., 'cluster-base'
    └── {ref}/                # e.g., 'main'
        └── .devcontainer/
            ├── Dockerfile
            └── ...
```

## Tarball Structure

### Before (cluster-templates)

```
generacy-ai-cluster-templates-{sha}/
├── standard/
│   └── .devcontainer/
│       ├── Dockerfile
│       ├── devcontainer.json
│       └── ...
└── microservices/
    └── .devcontainer/
        ├── Dockerfile
        └── ...
```

- Filter: only extract files matching `{variant}/` prefix
- Map: strip `{sha-prefix}/` AND `{variant}/`

### After (cluster-base / cluster-microservices)

```
generacy-ai-cluster-base-{sha}/
├── .devcontainer/
│   ├── Dockerfile
│   ├── devcontainer.json
│   └── ...
├── .generacy/
│   └── ...
└── .claude/
    └── ...
```

- Filter: accept all files (entire repo is relevant)
- Map: strip `{sha-prefix}/` only

## Function Signature Changes

### `getCacheDir()`

```typescript
// Before
function getCacheDir(ref: string, variant: ClusterVariant): string

// After
function getCacheDir(repoName: string, ref: string): string
```

### `mapArchivePath()`

```typescript
// Before
function mapArchivePath(archivePath: string, variant: ClusterVariant): string | null

// After
function mapArchivePath(archivePath: string): string | null
```

The `variant` parameter is removed — there's no variant prefix to strip.

## Validation Rules

- `variant` must be `'standard'` or `'microservices'` (unchanged, enforced by `ClusterVariant` type)
- `VARIANT_REPOS[variant]` must resolve to a valid repo slug (guaranteed by exhaustive `Record` type)
- `ref` defaults to `'main'` if not provided (changed from `'develop'`)

## Relationships

```
ClusterVariant ──1:1──▶ GitHub Repository (via VARIANT_REPOS map)
                          │
                          ▼
                      Tarball URL ──fetch──▶ Raw Files
                          │                      │
                          ▼                      ▼
                      Cache Dir           mapArchivePath()
                   {repo-name}/{ref}/     strips SHA prefix
```
