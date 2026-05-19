# Implementation Plan: Launch scaffolder must set DEPLOYMENT_MODE and CLUSTER_VARIANT env vars

**Feature**: Add missing `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars to generated docker-compose.yml
**Branch**: `531-context-launch-cli-s`
**Status**: Complete

## Summary

The shared cluster scaffolder (`cluster/scaffolder.ts`) generates `docker-compose.yml` files missing `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` environment variables. The control-plane reads these at boot for its `/state` endpoint. Without them, defaults (`local`/`cluster-base`) apply, causing incorrect variant reporting for cluster-microservices users and wrong deployment mode for cloud-deploy users.

The fix adds two fields to `ScaffoldComposeInput` (`variant`, `deploymentMode`) and two env var entries to the generated compose file. Both `launch` and `deploy` commands inherit the fix via the shared scaffolder. The `deploy` scaffolder passes `deploymentMode: 'cloud'`; `launch` defaults to `'local'`.

## Technical Context

**Language/Version**: TypeScript (ESM), Node >= 22
**Primary Dependencies**: `yaml` (stringify), `vitest` (testing), `zod` (schema validation)
**Storage**: File-based (writes `.generacy/docker-compose.yml`)
**Testing**: vitest — 3 existing test files covering the scaffolder
**Target Platform**: CLI (`@generacy-ai/generacy` package)
**Project Type**: Monorepo package (`packages/generacy/`)
**Constraints**: Single-file fix in shared scaffolder; callers must pass new fields

## Project Structure

### Documentation (this feature)

```text
specs/531-context-launch-cli-s/
├── spec.md              # Feature specification (read-only)
├── plan.md              # This file
├── research.md          # Technical decisions
├── data-model.md        # Interface changes
└── quickstart.md        # Testing guide
```

### Source Code (files to modify)

```text
packages/generacy/src/cli/commands/
├── cluster/
│   ├── scaffolder.ts              # PRIMARY: add variant + deploymentMode to ScaffoldComposeInput, add env vars
│   └── __tests__/scaffolder.test.ts  # Update: assert DEPLOYMENT_MODE + CLUSTER_VARIANT in compose output
├── launch/
│   ├── scaffolder.ts              # Update: pass variant to scaffoldDockerCompose
│   └── __tests__/scaffolder.test.ts  # Update: assert new env vars in scaffoldProject output
└── deploy/
    └── scaffolder.ts              # Update: pass variant + deploymentMode='cloud' to scaffoldDockerCompose

packages/generacy/tests/unit/deploy/
└── scaffolder.test.ts             # Update: assert new env vars in scaffoldBundle output
```

## Implementation Steps

### Step 1: Extend `ScaffoldComposeInput` interface

In `cluster/scaffolder.ts`, add two new fields:

```typescript
export interface ScaffoldComposeInput {
  imageTag: string;
  clusterId: string;
  projectId: string;
  cloudUrl: string;
  variant: 'cluster-base' | 'cluster-microservices';       // NEW
  deploymentMode?: 'local' | 'cloud';                       // NEW, defaults to 'local'
}
```

### Step 2: Add env vars to `scaffoldDockerCompose`

In the `environment` array, append:

```typescript
environment: [
  `GENERACY_CLOUD_URL=${input.cloudUrl}`,
  `GENERACY_CLUSTER_ID=${input.clusterId}`,
  `GENERACY_PROJECT_ID=${input.projectId}`,
  `DEPLOYMENT_MODE=${input.deploymentMode ?? 'local'}`,
  `CLUSTER_VARIANT=${input.variant}`,
],
```

### Step 3: Update `launch/scaffolder.ts`

Pass `variant` to the `scaffoldDockerCompose` call:

```typescript
scaffoldDockerCompose(generacyDir, {
  imageTag: config.imageTag,
  clusterId: config.clusterId,
  projectId: config.projectId,
  cloudUrl: config.cloudUrl,
  variant: config.variant as 'cluster-base' | 'cluster-microservices',
});
```

### Step 4: Update `deploy/scaffolder.ts`

Pass `variant` and `deploymentMode: 'cloud'`:

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

### Step 5: Update all 3 test files

- `cluster/__tests__/scaffolder.test.ts` — add `variant` to `scaffoldDockerCompose` input; assert `DEPLOYMENT_MODE=local` and `CLUSTER_VARIANT=cluster-base`
- `launch/__tests__/scaffolder.test.ts` — assert new env vars in compose output
- `tests/unit/deploy/scaffolder.test.ts` — assert `DEPLOYMENT_MODE=cloud` and `CLUSTER_VARIANT=standard` in compose output

### Step 6: Run tests and verify

```bash
cd packages/generacy && pnpm test
```
