# Quickstart: Control-Plane Daemon Crash Resilience

**Feature**: #624 | **Date**: 2026-05-15

## Overview

This feature prevents the control-plane daemon from crashing when non-critical stores fail to initialize, and makes the orchestrator detect and report control-plane unavailability.

## Testing the Changes

### 1. Unit Tests (Store Fallback)

```bash
# Run store fallback tests
pnpm --filter @generacy-ai/control-plane test -- --grep "AppConfigEnvStore"
pnpm --filter @generacy-ai/control-plane test -- --grep "AppConfigFileStore"
```

**What to verify**:
- EACCES on preferred path → store uses `/tmp/generacy-app-config/`
- Both paths fail → store enters disabled mode
- Disabled store `getAll()` returns empty array
- Disabled store `set()` throws `StoreDisabledError`

### 2. Unit Tests (Socket Probe)

```bash
# Run probe tests
pnpm --filter @generacy-ai/orchestrator test -- --grep "probeControlPlaneSocket"
```

**What to verify**:
- Returns `true` when socket exists and accepts connections
- Returns `false` when socket doesn't exist
- Returns `false` when socket exists but connection refused
- Respects timeout parameter

### 3. Integration Test (Zombie State Prevention)

```bash
# Run integration tests
pnpm --filter @generacy-ai/orchestrator test -- --grep "control-plane startup"
```

**What to verify**:
- Orchestrator pushes `error` status via relay when control-plane socket missing
- Orchestrator exits non-zero after grace window (~30s)
- Error status includes descriptive `statusReason`

### 4. Manual Testing in Dev Stack

```bash
# Start the dev stack
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh

# Simulate EACCES: make the app-config dir unwritable
docker exec generacy-orchestrator chmod 000 /var/lib/generacy-app-config

# Restart control-plane (inside the container)
docker exec generacy-orchestrator kill -TERM $(docker exec generacy-orchestrator pgrep -f control-plane)

# Check control-plane logs for fallback behavior
docker exec generacy-orchestrator cat /tmp/control-plane.log | grep store-init

# Check orchestrator health for controlPlaneReady field
curl -s http://localhost:3100/health | jq '.controlPlaneReady'

# Check init-result.json
docker exec generacy-orchestrator cat /run/generacy-control-plane/init-result.json | jq .
```

### 5. Verify Relay Metadata

After the store fallback occurs, relay metadata should include the init result:

```bash
# In the dev stack, check relay metadata via orchestrator logs
docker exec generacy-orchestrator cat /tmp/orchestrator.log | grep initResult
```

Expected metadata fields:
- `controlPlaneReady: true` (daemon is running, just store degraded)
- `initResult.stores.appConfigEnv: "fallback"` (using tmpfs)
- `initResult.warnings: ["EACCES on /var/lib/generacy-app-config/env, using /tmp/generacy-app-config/env"]`

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Control-plane logs show `status: "disabled"` | Both preferred and `/tmp/` paths unwritable | Check container filesystem permissions, verify tmpfs is mounted |
| Orchestrator exits after 30s with error status | Control-plane socket never bound | Check control-plane process is starting; read `/tmp/control-plane.log` |
| `controlPlaneReady: false` but control-plane is running | Socket path mismatch | Verify `CONTROL_PLANE_SOCKET_PATH` env var matches between both processes |
| Relay metadata missing `initResult` | `init-result.json` not written or not readable | Check `/run/generacy-control-plane/init-result.json` exists with correct permissions |

## Files Changed

| File | Change |
|------|--------|
| `packages/control-plane/src/types/init-result.ts` | New: `StoreStatus`, `StoreInitResult`, `InitResult`, `StoreDisabledError` |
| `packages/control-plane/src/services/app-config-env-store.ts` | Modified: fallback path + disabled mode |
| `packages/control-plane/src/services/app-config-file-store.ts` | Modified: fallback path + disabled mode |
| `packages/control-plane/bin/control-plane.ts` | Modified: structured init, emit init results |
| `packages/orchestrator/src/services/control-plane-probe.ts` | New: `probeControlPlaneSocket()` |
| `packages/orchestrator/src/routes/health.ts` | Modified: `controlPlaneReady` field |
| `packages/orchestrator/src/services/relay-bridge.ts` | Modified: metadata includes control-plane fields |
| `packages/orchestrator/src/server.ts` | Modified: startup socket-wait + grace exit |
| `packages/orchestrator/src/types/relay.ts` | Modified: `ClusterMetadataPayload` extended |
| `packages/cluster-relay/src/metadata.ts` | Modified: reads `controlPlaneReady` from `/health` |
