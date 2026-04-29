# Data Model: CLI claude-login and open commands

**Feature**: #496 | **Date**: 2026-04-29

## Core Entities

### ClusterContext

Resolved cluster identity for CLI commands. Produced by `getClusterContext()`.

```typescript
interface ClusterContext {
  /** Cluster ID (also docker compose project name) */
  clusterId: string;
  /** Generacy cloud project ID */
  projectId: string;
  /** Organization ID */
  orgId: string;
  /** Cloud URL (e.g., "https://api.generacy.ai") */
  cloudUrl: string;
  /** Absolute path to the project's .generacy/ directory */
  generacyDir: string;
  /** Absolute path to the project root (parent of .generacy/) */
  projectDir: string;
}
```

### ProjectClusterJson

Per-project cluster identity file at `.generacy/cluster.json`. Mirrors fields from the in-container `ClusterJson` written during activation.

```typescript
import { z } from 'zod';

const ProjectClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime(),
});

type ProjectClusterJson = z.infer<typeof ProjectClusterJsonSchema>;
```

**Note**: This reuses the same `ClusterJsonSchema` already defined in `packages/orchestrator/src/activation/types.ts`. The CLI should import it from there or define a compatible copy to avoid coupling to the orchestrator package.

### ClusterRegistryEntry

Entry in the host-side registry at `~/.generacy/clusters.json`. Defined by #494.

```typescript
import { z } from 'zod';

const ClusterRegistryEntrySchema = z.object({
  clusterId: z.string().min(1),
  projectId: z.string().min(1),
  orgId: z.string().min(1),
  cloudUrl: z.string().url(),
  path: z.string().min(1),         // Absolute path to project root
  activatedAt: z.string().datetime(),
  status: z.enum(['running', 'stopped', 'unknown']).optional(),
});

const ClusterRegistrySchema = z.object({
  version: z.literal(1),
  clusters: z.array(ClusterRegistryEntrySchema),
});

type ClusterRegistryEntry = z.infer<typeof ClusterRegistryEntrySchema>;
type ClusterRegistry = z.infer<typeof ClusterRegistrySchema>;
```

**Note**: Exact schema is owned by #494. This is the minimal shape #496 depends on.

### UrlScanResult

Result from the URL scanner transform stream.

```typescript
interface UrlScanResult {
  /** The first URL detected in stdout, or null if none found */
  url: string | null;
}
```

## Relationships

```
~/.generacy/clusters.json (ClusterRegistry)
    └── contains N ClusterRegistryEntry records
         └── each maps to a project directory

<project>/.generacy/cluster.json (ProjectClusterJson)
    └── per-project identity, subset of registry entry

getClusterContext(cwd)
    ├── reads: .generacy/cluster.json (walk-up from cwd)
    ├── reads: ~/.generacy/clusters.json (optional cross-reference)
    └── produces: ClusterContext

claude-login command
    ├── uses: ClusterContext.projectDir (for compose --project-directory)
    ├── uses: ClusterContext.clusterId (for compose --project-name)
    └── produces: UrlScanResult (for browser auto-open)

open command
    ├── uses: ClusterContext.cloudUrl
    ├── uses: ClusterContext.clusterId
    └── constructs: {cloudUrl}/clusters/{clusterId}
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `cluster_id` | Non-empty string | "Invalid cluster.json: missing cluster_id" |
| `cloud_url` | Valid URL (https) | "Invalid cluster.json: cloud_url must be a valid URL" |
| `clusters.json` version | Must be `1` | "Unsupported registry version" |
| `--cluster <id>` | Must exist in registry | "Cluster '{id}' not found in registry" |
| URL pattern | `https?://\S+` | No error — just no auto-open if no match |

## File Locations

| File | Path | Owner |
|------|------|-------|
| Per-project cluster identity | `<project>/.generacy/cluster.json` | Written during cluster setup (#494) |
| Host-side cluster registry | `~/.generacy/clusters.json` | Managed by lifecycle commands (#494) |
| In-container cluster metadata | `/var/lib/generacy/cluster.json` | Written by activation module (#492) |
