# Implementation Plan: Forward Registry Credentials to Credhelper After Launch

**Feature**: After `generacy launch` pulls the cluster image using scoped registry credentials, forward them to the cluster's credhelper so future `generacy update` re-pulls don't require re-prompting. Delete local scoped config afterward.
**Branch**: `640-context-after-generacy-launch`
**Status**: Complete

## Summary

Add a post-activation step to `launchAction` that:
1. Probes the control-plane socket for readiness (retry loop)
2. PUTs each `registryCredentials` entry to `PUT /credentials/registry-<host>` via `docker compose exec`
3. Deletes the scoped `<projectDir>/.generacy/.docker/` directory on success
4. Logs a warning (non-fatal) on failure

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Package**: `packages/generacy` (CLI)
- **Framework**: Commander.js CLI, `node:child_process` for docker compose exec
- **Dependencies**: No new deps; uses existing `execSync`/`spawnSync` patterns from launch command
- **Target file**: `packages/generacy/src/cli/commands/launch/index.ts` (main orchestration)

## Project Structure

```
packages/generacy/src/cli/commands/launch/
  index.ts                 # MODIFY: add step 12 (credential forward + cleanup)
  types.ts                 # MODIFY: extend LaunchConfigSchema with registryCredentials
  credential-forward.ts    # NEW: credential forwarding logic (probe + PUT + cleanup)
```

## Implementation Steps

### Step 1: Extend LaunchConfigSchema

Add `registryCredentials` field to `LaunchConfigSchema` in `types.ts`:

```typescript
registryCredentials: z.array(z.object({
  host: z.string(),
  auth: z.string(),
})).optional()
```

### Step 2: Create credential-forward.ts

New module with three exported functions:

1. **`probeControlPlaneReady(projectDir, opts)`** — Runs `docker compose exec orchestrator node -e "..."` with a socket probe script (or `curl --unix-socket`) against `/run/generacy-control-plane/control.sock`. Retries up to N times with backoff. Returns boolean.

2. **`forwardRegistryCredentials(projectDir, credentials)`** — For each `{ host, auth }` entry, runs `docker compose exec -T orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -X PUT http://localhost/credentials/registry-<host> -H 'Content-Type: application/json' -H 'x-generacy-actor-user-id: system:cli-launch' -d '{"type":"registry","value":"<auth>"}'`. Returns `{ forwarded: string[], failed: string[] }`.

3. **`cleanupScopedDockerConfig(projectDir)`** — Removes `<projectDir>/.generacy/.docker/` directory recursively.

### Step 3: Integrate into launchAction

After `streamLogsUntilActivation()` resolves and before `registerCluster()`:

```typescript
if (config.registryCredentials?.length) {
  const ready = await probeControlPlaneReady(projectDir, { retries: 10, intervalMs: 2000 });
  if (ready) {
    const result = await forwardRegistryCredentials(projectDir, config.registryCredentials);
    if (result.forwarded.length > 0) {
      cleanupScopedDockerConfig(projectDir);
    }
    if (result.failed.length > 0) {
      logger.warn(`Failed to forward credentials for: ${result.failed.join(', ')}`);
    }
  } else {
    logger.warn('Control-plane not ready — skipping credential forward. Re-enter via cloud UI.');
  }
}
```

### Step 4: Tests

- Unit tests for `credential-forward.ts` (mock `execSync`/`spawnSync`)
- Success path: probe succeeds, PUT returns 200, cleanup runs
- Control-plane unreachable: probe times out, warning logged, no cleanup
- PUT rejection: forward returns failure, warning logged, no cleanup

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Array shape for `registryCredentials` | Future-proofs multi-registry; additive extension (Q1 answer) |
| Readiness probe before PUT | Eliminates race between log-pattern detection and socket readiness (Q2 answer) |
| Synthetic actor `system:cli-launch` | Honest audit trail; CLI has no real user identity at this point (Q3 answer) |
| Delete entire `.generacy/.docker/` dir | CLI created it, CLI owns lifecycle; no orphaned empty dirs (Q4 answer) |
| `docker compose exec` for PUT | Control-plane socket is inside the container; CLI cannot reach it directly from host |
| Non-fatal failure | Creds can be re-entered via cloud UI; don't block launch for a secondary concern |

## Control-Plane Readiness Probe Design

The probe runs inside the container using `docker compose exec`:
```bash
docker compose exec -T orchestrator \
  curl -sf --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/state
```

- Uses `GET /state` (lightweight, always available when control-plane is up)
- `-s` (silent) + `-f` (fail on HTTP error) for clean exit code signaling
- Retry: 10 attempts, 2s interval (20s total window)
- Matches existing pattern from `packages/orchestrator/src/services/control-plane-probe.ts`

## Credential PUT Request Shape

```json
PUT /credentials/registry-private.example.com
Content-Type: application/json
x-generacy-actor-user-id: system:cli-launch

{
  "type": "registry",
  "value": "<base64-encoded auth>"
}
```

The `value` field is the raw Docker auth string (base64-encoded `user:password`), matching the format stored in `~/.docker/config.json` under `auths.<host>.auth`.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| `curl` not available in container | cluster-base image includes curl; add assertion in probe step |
| Control-plane route rejects `registry` type | Credential type is free-form string in `PutCredentialBodySchema`; no enum restriction |
| Race with orchestrator activation | Probe waits for control-plane, not just orchestrator |
| Large auth values | base64 Docker auth is typically < 1KB; well within curl/exec limits |
