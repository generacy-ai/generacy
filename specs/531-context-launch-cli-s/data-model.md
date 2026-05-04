# Data Model: Launch scaffolder env vars

**Feature**: #531 — DEPLOYMENT_MODE and CLUSTER_VARIANT env vars
**Date**: 2026-05-04

## Interface Changes

### `ScaffoldComposeInput` (modified)

```typescript
// packages/generacy/src/cli/commands/cluster/scaffolder.ts

export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  cloudUrl: string;
  variant: 'cluster-base' | 'cluster-microservices';  // NEW — required
  deploymentMode?: 'local' | 'cloud';                  // NEW — optional, defaults to 'local'
}
```

### Generated `docker-compose.yml` environment array (modified)

Before:
```yaml
environment:
  - GENERACY_CLOUD_URL=https://api.generacy.ai
  - GENERACY_CLUSTER_ID=clust_abc
  - GENERACY_PROJECT_ID=proj_def
```

After:
```yaml
environment:
  - GENERACY_CLOUD_URL=https://api.generacy.ai
  - GENERACY_CLUSTER_ID=clust_abc
  - GENERACY_PROJECT_ID=proj_def
  - DEPLOYMENT_MODE=local
  - CLUSTER_VARIANT=cluster-base
```

## Call Site Changes

### `launch/scaffolder.ts`

```typescript
scaffoldDockerCompose(generacyDir, {
  imageTag: config.imageTag,
  clusterId: config.clusterId,
  projectId: config.projectId,
  cloudUrl: config.cloudUrl,
  variant: config.variant as 'cluster-base' | 'cluster-microservices',
  // deploymentMode omitted → defaults to 'local'
});
```

### `deploy/scaffolder.ts`

```typescript
scaffoldDockerCompose(tmpDir, {
  imageTag: config.imageTag,
  clusterId: activation.clusterId,
  projectId: activation.projectId,
  cloudUrl,
  variant: config.variant as 'cluster-base' | 'cluster-microservices',
  deploymentMode: 'cloud',
});
```

## Type Values

| Field | Type | Values | Default |
|-------|------|--------|---------|
| `variant` | string literal union | `'cluster-base'` \| `'cluster-microservices'` | required, no default |
| `deploymentMode` | string literal union | `'local'` \| `'cloud'` | `'local'` |
