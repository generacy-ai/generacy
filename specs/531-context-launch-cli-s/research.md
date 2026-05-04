# Research: Launch scaffolder env vars

**Feature**: #531 — DEPLOYMENT_MODE and CLUSTER_VARIANT env vars
**Date**: 2026-05-04

## Problem Analysis

The control-plane reads two env vars at startup:

```ts
const deploymentMode = (process.env['DEPLOYMENT_MODE'] ?? 'local') as DeploymentMode;
const variant = (process.env['CLUSTER_VARIANT'] ?? 'cluster-base') as ClusterVariant;
```

The shared scaffolder writes `docker-compose.yml` with only `GENERACY_CLOUD_URL`, `GENERACY_CLUSTER_ID`, and `GENERACY_PROJECT_ID`. The missing vars cause the control-plane `/state` endpoint to return incorrect defaults.

## Approach Decision

**Option A (chosen): Add fields to `ScaffoldComposeInput` + env vars in shared scaffolder**
- Single change point — both `launch` and `deploy` inherit the fix
- `variant` is required (always known from launch-config/deploy-config)
- `deploymentMode` is optional, defaults to `'local'`
- Deploy command explicitly passes `'cloud'`

**Option B (rejected): Hard-code env vars per command**
- Would duplicate logic in launch and deploy scaffolders
- Violates the DRY principle that led to the shared scaffolder

**Option C (rejected): Change control-plane defaults**
- Out of scope per spec; would mask the real problem

## Key Observations

1. **`variant` is already available** at all call sites — `launch/scaffolder.ts` already has `config.variant`, `deploy/scaffolder.ts` already has `config.variant`
2. **Deploy scaffolder uses a different compose layout** — writes `docker-compose.yml` at temp root (not inside `.generacy/`), but still calls `scaffoldDockerCompose` from the shared scaffolder
3. **Deploy test uses `variant: 'standard'`** — this is a test fixture quirk; real deploy configs use `'cluster-base'` or `'cluster-microservices'`. The test will assert whatever variant is in the fixture.
4. **No new dependencies** required

## Risk Assessment

- **Low risk**: Pure additive change — adding env vars to a generated file
- **No breaking changes**: Existing env vars unchanged; new vars are additive
- **Test coverage**: 3 existing test files already cover the scaffolder; just need assertion updates
