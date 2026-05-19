# Data Model: Project Directory Resolver

## Core Interface

```typescript
// packages/control-plane/src/services/project-dir-resolver.ts

/**
 * Resolves the .generacy directory path using 4-tier discovery.
 * Result is cached after first successful resolution.
 */
export async function resolveGeneracyDir(): Promise<string>;

/**
 * Reset the cached resolution (for testing only).
 */
export function resetGeneracyDirCache(): void;
```

## Resolution Tiers

```typescript
interface ResolutionResult {
  /** The resolved absolute path to the .generacy directory */
  path: string;
  /** Which tier resolved successfully */
  tier: 1 | 2 | 3 | 4;
  /** Human-readable description of the resolution source */
  source: string;
}
```

## Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `GENERACY_PROJECT_DIR` | Explicit project root override | `/workspaces/my-project` |
| `WORKSPACE_DIR` | Workspace root (orchestrator convention) | `/workspaces/my-project` |

## File System Layout (expected)

```
/workspaces/
├── <project-name>/
│   └── .generacy/
│       ├── cluster.yaml      # Contains appConfig section
│       ├── cluster.json      # Runtime metadata
│       └── docker-compose.yml
└── (possibly other dirs, ignored)
```

## cluster.yaml appConfig Section (existing schema, unchanged)

```typescript
// Already defined in packages/control-plane/src/schemas.ts
const AppConfigSchema = z.object({
  schemaVersion: z.string(),
  env: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    default: z.string().optional(),
  })).optional(),
  files: z.array(z.object({
    id: z.string(),
    mountPath: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })).optional(),
});
```

## Validation Rules

- Tier 1/2: Path must be absolute after `path.resolve()`
- Tier 3: Exactly one match required; >1 is ambiguous, 0 is miss
- All tiers: Result is a directory path (existence not strictly required — `readManifest()` handles ENOENT gracefully)
