# Data Model: Reconcile launch CLI schemas with lifecycle commands

**Feature**: #518 | **Date**: 2026-04-30

## Core Schemas

### 1. `cluster.json` — Cluster Identity (snake_case)

Written to `.generacy/cluster.json` by launch/deploy scaffolders. Read by lifecycle commands via `ClusterJsonSchema`.

```typescript
// packages/generacy/src/cli/commands/cluster/context.ts
export const ClusterJsonSchema = z.object({
  cluster_id: z.string().min(1),
  project_id: z.string().min(1),
  org_id: z.string().min(1),
  cloud_url: z.string().url(),
  activated_at: z.string().datetime().optional(),  // CHANGED: was required
});

export type ClusterJson = z.infer<typeof ClusterJsonSchema>;
```

**Changes from current**:
- `activated_at` → **optional** (launch scaffolds before activation; populated container-side by #492)
- Field names remain snake_case (already correct in reader)
- Writers must emit snake_case (currently camelCase — the core bug)

**Example output**:
```json
{
  "cluster_id": "clust_abc123",
  "project_id": "proj_def456",
  "org_id": "org_ghi789",
  "cloud_url": "https://api.generacy.ai"
}
```

### 2. `cluster.yaml` — Project Config

Written to `.generacy/cluster.yaml`. Read by lifecycle commands via `ClusterYamlSchema`.

```typescript
// packages/generacy/src/cli/commands/cluster/context.ts
export const ClusterYamlSchema = z.object({
  channel: z.enum(['stable', 'preview']).default('stable'),
  workers: z.number().int().positive().default(1),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),
  // REMOVED: imageTag, cloudUrl, ports (belong in docker-compose.yml / cluster.json)
});

export type ClusterYaml = z.infer<typeof ClusterYamlSchema>;
```

**Changes from current**:
- `variant` enum: `'standard' | 'microservices'` → `'cluster-base' | 'cluster-microservices'`
- Writers must NOT include `imageTag`, `cloudUrl`, `ports` (currently written by launch/deploy)

**Example output**:
```yaml
channel: stable
workers: 1
variant: cluster-base
```

### 3. `LaunchConfigSchema` — Cloud API Response

Response from `GET /api/clusters/launch-config?claim=<code>`.

```typescript
// packages/generacy/src/cli/commands/launch/types.ts
export const LaunchConfigSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),          // NEW: required
  repos: z.object({
    primary: z.string().min(1),
    dev: z.string().optional(),
    clone: z.string().optional(),
  }),
});

export type LaunchConfig = z.infer<typeof LaunchConfigSchema>;
```

**Changes from current**:
- Added `orgId: z.string().min(1)` (required — forces cloud #474 to ship first)

### 4. `RegistryEntrySchema` — `~/.generacy/clusters.json` entries

```typescript
// packages/generacy/src/cli/commands/cluster/registry.ts
export const RegistryEntrySchema = z.object({
  clusterId: z.string().nullable(),                                    // nullable for pre-activation
  name: z.string(),
  path: z.string(),
  composePath: z.string(),
  variant: z.enum(['cluster-base', 'cluster-microservices']).default('cluster-base'),  // CHANGED
  channel: z.enum(['stable', 'preview']).default('stable'),
  cloudUrl: z.string().nullable(),
  lastSeen: z.string().datetime(),
  createdAt: z.string().datetime(),
  managementEndpoint: z.string().optional(),
});

export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;
```

**Changes from current**:
- `variant` enum: `'standard' | 'microservices'` → `'cluster-base' | 'cluster-microservices'`

### 5. Shared Scaffolder Interfaces (NEW)

```typescript
// packages/generacy/src/cli/commands/cluster/scaffolder.ts

export interface ScaffoldClusterJsonInput {
  cluster_id: string;
  project_id: string;
  org_id: string;
  cloud_url: string;
}

export interface ScaffoldClusterYamlInput {
  channel?: 'stable' | 'preview';
  workers?: number;
  variant: 'cluster-base' | 'cluster-microservices';
}

export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  cloudUrl: string;
}
```

## Types to Remove

These local types in `launch/types.ts` are replaced by shared schemas:

```typescript
// REMOVE from launch/types.ts:
interface ClusterRegistryEntry { ... }  // → use RegistryEntry from cluster/registry.ts
type ClusterRegistry = ...              // → use Registry from cluster/registry.ts
interface ClusterYaml { ... }           // → use ClusterYaml from cluster/context.ts
interface ClusterMetadata { ... }       // → use ClusterJson from cluster/context.ts
```

## Field Mapping: Writer → Schema

### Launch command

| LaunchConfig field | cluster.json field | cluster.yaml field | docker-compose.yml |
|---|---|---|---|
| `clusterId` | `cluster_id` | — | `GENERACY_CLUSTER_ID` |
| `projectId` | `project_id` | — | `GENERACY_PROJECT_ID` |
| `orgId` (NEW) | `org_id` | — | — |
| `cloudUrl` | `cloud_url` | — | `GENERACY_CLOUD_URL` |
| `variant` | — | `variant` | — |
| `imageTag` | — | — | `image:` |
| `projectName` | — | — | — (used for dir name only) |

### Deploy command

| Source | cluster.json field | cluster.yaml field | docker-compose.yml |
|---|---|---|---|
| `activation.clusterId` | `cluster_id` | — | `GENERACY_CLUSTER_ID` |
| `activation.projectId` | `project_id` | — | `GENERACY_PROJECT_ID` |
| `activation.orgId` | `org_id` | — | — |
| `cloudUrl` (param) | `cloud_url` | — | `GENERACY_CLOUD_URL` |
| `config.variant` | — | `variant` | — |
| `config.imageTag` | — | — | `image:` |

## Validation Rules

- `cluster_id`, `project_id`, `org_id`: non-empty strings (`z.string().min(1)`)
- `cloud_url`: valid URL (`z.string().url()`)
- `activated_at`: ISO 8601 datetime or absent (`z.string().datetime().optional()`)
- `variant`: strict enum `'cluster-base' | 'cluster-microservices'`
- `channel`: strict enum `'stable' | 'preview'`
- `workers`: positive integer, defaults to 1
- `clusterId` in registry: nullable (null for pre-activation clusters)
