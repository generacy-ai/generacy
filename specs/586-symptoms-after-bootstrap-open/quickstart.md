# Quickstart: Open IDE Flow Fix (#586)

## Prerequisites

- Development stack running (Firebase emulators)
- pnpm installed

## Setup

```bash
cd /workspaces/generacy
pnpm install
```

## Running Tests

```bash
# Unit tests for affected packages
pnpm --filter @generacy-ai/control-plane test
pnpm --filter @generacy-ai/orchestrator test
pnpm --filter @generacy-ai/cluster-relay test

# Or run all tests
pnpm test
```

## Manual Verification

### 1. Code-Server Starts After Bootstrap

```bash
# In a running cluster:
docker exec <orchestrator> ls -la /run/code-server.sock
# Should show the socket file after bootstrap-complete
```

### 2. Health Endpoint Shows codeServerReady

```bash
# From inside the cluster:
curl http://localhost:3100/health | jq '.codeServerReady'
# Should return true after code-server starts
```

### 3. Metadata Includes codeServerReady

Check Firestore cluster doc after a fresh launch — `codeServerReady` should be `true`.

### 4. Open IDE Button Works

1. Complete cluster bootstrap in the web wizard
2. On ReadyStep, "Open IDE" button should be enabled
3. Clicking opens the cluster's code-server (not vscode.dev/tunnel)
4. IDE shows `/workspaces/<project>` directory

## Key Files

| File | Change |
|------|--------|
| `packages/control-plane/src/routes/lifecycle.ts` | Trigger code-server-start on bootstrap-complete |
| `packages/control-plane/src/services/code-server-manager.ts` | Add onStatusChange callback |
| `packages/orchestrator/src/server.ts` | Add /code-server relay route |
| `packages/orchestrator/src/routes/health.ts` | Add codeServerReady to /health |
| `packages/orchestrator/src/types/api.ts` | Extend HealthResponseSchema |
| `packages/orchestrator/src/services/relay-bridge.ts` | Add codeServerReady to collectMetadata |
| `packages/cluster-relay/src/metadata.ts` | Read codeServerReady from /health |

## Troubleshooting

**Button stays disabled**: Check that code-server actually started — look for errors in control-plane logs. Verify `getCodeServerManager().getStatus()` returns `'running'`.

**404 on IDE proxy**: Verify the `/code-server` route is registered in relay client routes. Check orchestrator startup logs for route registration.

**Metadata not reaching cloud**: Check relay connection status. Verify `collectMetadata()` includes `codeServerReady` in both paths (handshake and periodic).
