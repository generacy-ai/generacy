# Quickstart: Fix `codeServerReady` Cross-Process Singleton Bug

**Feature**: #596 | **Date**: 2026-05-12

## What Changed

The orchestrator's `/health` endpoint and `relay-bridge.ts` metadata collector now probe the actual code-server unix socket instead of querying a cross-process singleton that always returns `'stopped'`.

## Files Modified

| File | Change |
|------|--------|
| `packages/orchestrator/src/services/code-server-probe.ts` | **NEW** — `probeCodeServerSocket()` helper |
| `packages/orchestrator/src/routes/health.ts` | Replace `getCodeServerManager()` with `probeCodeServerSocket()` |
| `packages/orchestrator/src/services/relay-bridge.ts` | Make `collectMetadata()`/`sendMetadata()` async, use probe |
| `packages/orchestrator/src/__tests__/health-code-server.test.ts` | Update mocks for probe |
| `packages/orchestrator/tests/unit/services/code-server-probe.test.ts` | **NEW** — probe unit tests |
| `packages/orchestrator/tests/unit/services/relay-bridge-metadata.test.ts` | Update for async |

## Running Tests

```bash
# Unit tests for the probe
pnpm --filter @generacy-ai/orchestrator test -- code-server-probe

# Health endpoint tests
pnpm --filter @generacy-ai/orchestrator test -- health-code-server

# Relay bridge metadata tests
pnpm --filter @generacy-ai/orchestrator test -- relay-bridge-metadata

# All orchestrator tests
pnpm --filter @generacy-ai/orchestrator test
```

## Manual Verification

### 1. Verify with code-server running

```bash
# Inside the orchestrator container
docker exec <orchestrator> curl -s http://127.0.0.1:3100/health | jq .codeServerReady
# Expected: true

# Verify socket is actually there
docker exec <orchestrator> ls -la /run/generacy-control-plane/code-server.sock
# Expected: srw-rw---- 1 node node ...
```

### 2. Verify with code-server stopped

```bash
# Stop code-server (if running)
docker exec <orchestrator> pkill -f code-server

# Check health
docker exec <orchestrator> curl -s http://127.0.0.1:3100/health | jq .codeServerReady
# Expected: false (within ~500ms, no hang)
```

### 3. End-to-end: "Open IDE" button

1. Create a fresh project via the cloud wizard
2. Complete bootstrap (all steps through ReadyStep)
3. Wait ~10 seconds for code-server to start and metadata to propagate
4. The "Open IDE" button should be enabled
5. Click it — code-server should load in the iframe

## Troubleshooting

### `/health` still returns `codeServerReady: false`

1. Check if code-server is actually running:
   ```bash
   docker exec <orchestrator> ps aux | grep code-server
   ```
2. Check socket path matches:
   ```bash
   docker exec <orchestrator> echo $CODE_SERVER_SOCKET_PATH
   # Should be /run/generacy-control-plane/code-server.sock (or unset for default)
   ```
3. Check socket permissions:
   ```bash
   docker exec <orchestrator> ls -la /run/generacy-control-plane/code-server.sock
   # Orchestrator process (uid 1000) must be able to connect
   ```

### Probe timeout on every call

If `/health` takes ~500ms consistently, code-server's socket may exist but the process isn't accepting connections (hung/deadlocked). Check:
```bash
docker exec <orchestrator> curl --unix-socket /run/generacy-control-plane/code-server.sock http://localhost/
# Should return HTML or a redirect, not hang
```
