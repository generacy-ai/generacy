# Research: Reconcile launch CLI schemas with lifecycle commands

**Feature**: #518 | **Date**: 2026-04-30

## Problem Analysis

### Root Cause

The `launch` (#495) and `deploy` (#500) commands were implemented after the lifecycle commands (#494), but their scaffolders were written with ad-hoc TypeScript interfaces instead of importing the Zod schemas from `cluster/context.ts` and `cluster/registry.ts`. This created two incompatible schema definitions for the same files.

### Schema Drift Inventory

| File | Writer (launch/deploy) | Reader (lifecycle) | Conflict |
|------|----------------------|-------------------|----------|
| `cluster.json` | camelCase (`clusterId`) | snake_case (`cluster_id`) | **Field naming** |
| `cluster.json` | missing `org_id` | requires `org_id` | **Missing required field** |
| `cluster.json` | missing `activated_at` | requires `activated_at` | **Missing required field** |
| `cluster.json` | includes `projectName`, `imageTag` | not in schema | Extra fields (harmless but noisy) |
| `cluster.yaml` | `{variant, imageTag, cloudUrl, ports}` | `{channel, workers, variant}` | **Schema mismatch** (Zod strips extras, applies defaults) |
| Registry | `launch/registry.ts` (no validation) | `cluster/registry.ts` (Zod validated) | **Bypass of validation** |
| Registry | `variant: string` (free) | `variant: z.enum(...)` | **Type mismatch** |

## Technology Decisions

### 1. Snake_case for cluster.json

**Decision**: Use snake_case field names (`cluster_id`, `project_id`, `org_id`, `cloud_url`).

**Rationale**: The orchestrator's container-side `/var/lib/generacy/cluster.json` (written by activation flow in #492) uses snake_case. The lifecycle commands already read snake_case. The launch/deploy scaffolders are the only writers using camelCase. Standardizing on snake_case aligns host-side and container-side files.

**Alternative rejected**: Convert lifecycle readers to camelCase — would require changing the orchestrator's activation persistence too, creating a larger blast radius.

### 2. Shared scaffolder extraction

**Decision**: Extract shared scaffolding functions to `cluster/scaffolder.ts`.

**Rationale**: Both `launch/scaffolder.ts` and `deploy/scaffolder.ts` write the same three files (`cluster.json`, `cluster.yaml`, `docker-compose.yml`) with nearly identical logic. A shared helper eliminates the duplication that caused this bug.

**Pattern**: Each caller maps its own config types (LaunchConfig vs ActivationResult) to the shared scaffolder's input interface. The shared scaffolder owns the file format.

**Alternative rejected**: Keep separate scaffolders but import shared schema — still duplicates file-writing logic and risks future drift.

### 3. Reuse `checkNodeVersion()` from utils

**Decision**: Replace inline `validateNodeVersion()` in `launch/index.ts` with the existing `checkNodeVersion()` utility from `src/cli/utils/node-version.ts` (#493).

**Rationale**: `checkNodeVersion()` already gates on Node >=22, provides a user-friendly error message with install link, and is used by the CLI entry point. Duplicating version-check logic in individual commands is unnecessary.

### 4. Variant enum rename

**Decision**: Rename `'standard' | 'microservices'` to `'cluster-base' | 'cluster-microservices'` in both `ClusterYamlSchema` and `RegistryEntrySchema`.

**Rationale**: Per clarification Q4, these values must match GHCR image repo names and the architecture doc. The cloud API (#474) will use the same enum.

### 5. Registry write unification

**Decision**: Eliminate `launch/registry.ts` as a standalone module. Have `launch/index.ts` call `upsertRegistryEntry()` from `cluster/registry.ts` directly, or validate via `RegistryEntrySchema` before writing.

**Rationale**: `launch/registry.ts` duplicates the atomic-write logic and bypasses Zod validation. The lifecycle registry already handles upsert, atomic writes, and schema validation.

**Challenge**: `upsertRegistryEntry()` takes a `ClusterContext` (output of `getClusterContext()`), not a plain entry object. Two approaches:
- A: Add a lower-level `addRegistryEntry(entry: RegistryEntry)` to `cluster/registry.ts`
- B: Construct a `ClusterContext` from the scaffolded files and call existing `upsertRegistryEntry()`

Approach A is simpler — the launch command already has all the data, it just needs to validate and append.

## Implementation Patterns

### Shared scaffolder interface

```typescript
// cluster/scaffolder.ts
interface ScaffoldClusterJsonInput {
  cluster_id: string;
  project_id: string;
  org_id: string;
  cloud_url: string;
}

interface ScaffoldClusterYamlInput {
  channel: 'stable' | 'preview';
  workers: number;
  variant: 'cluster-base' | 'cluster-microservices';
}

interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  cloudUrl: string;
}
```

### Launch → shared scaffolder mapping

```typescript
// launch/scaffolder.ts
scaffoldClusterJson(dir, {
  cluster_id: config.clusterId,
  project_id: config.projectId,
  org_id: config.orgId,       // NEW field from updated LaunchConfigSchema
  cloud_url: config.cloudUrl,
});
```

### Deploy → shared scaffolder mapping

```typescript
// deploy/scaffolder.ts
scaffoldClusterJson(dir, {
  cluster_id: activation.clusterId,
  project_id: activation.projectId,
  org_id: activation.orgId,    // from device-flow ActivationResult
  cloud_url: cloudUrl,
});
```

## Key Sources

- #494 — Lifecycle commands (defines `ClusterJsonSchema`, `RegistryEntrySchema`)
- #495 — Launch command (defines `LaunchConfigSchema`, `ClusterMetadata`)
- #500 — Deploy command (reuses launch patterns, same bugs)
- #493 — `checkNodeVersion()` utility
- #492 — Orchestrator activation (defines container-side `cluster.json` format)
- #474 — Companion cloud issue (must ship `orgId` in launch-config response)
