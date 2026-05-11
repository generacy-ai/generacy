# Quickstart: Fix cloud-to-cluster /control-plane/* 404s

**Branch**: `574-symptoms-bootstrap-wizard` | **Date**: 2026-05-11

## What This Fixes

Bootstrap wizard Step 1 ("Install GitHub App") fails with `Failed to write credential (404)` because the relay doesn't route `/control-plane/*` requests to the control-plane unix socket.

## Changes

Two files, ~10 lines total:

1. **`packages/cluster-relay/src/relay.ts`** — Add `routes?: RouteEntry[]` to `ClusterRelayClientOptions`, thread to config parse
2. **`packages/orchestrator/src/server.ts`** — Pass `/control-plane → unix socket` route in `initializeRelayBridge`

## Verification

### Unit tests

```bash
# Run cluster-relay tests
cd packages/cluster-relay && pnpm test

# Run orchestrator tests
cd packages/orchestrator && pnpm test
```

### Manual verification

1. Build and start a cluster with the control-plane process running (requires companion cluster-base PR)
2. Run `npx generacy launch --claim=<code>`
3. In the bootstrap wizard, complete Step 1 ("Install GitHub App")
4. Verify the credential write succeeds (no 404 error)

### Debug: Confirm route registration

In the orchestrator logs, look for the relay client initialization. After the fix, the relay config should include:

```json
{
  "routes": [
    { "prefix": "/control-plane", "target": "unix:///run/generacy-control-plane/control.sock" }
  ]
}
```

### Debug: Confirm request routing

When a `PUT /control-plane/credentials/<id>` arrives via the relay:
- The dispatcher matches prefix `/control-plane`
- Strips prefix to `/credentials/<id>`
- Forwards to the unix socket
- Control-plane responds 200

## Dependencies

- **Companion PR needed**: cluster-base must install and spawn `@generacy-ai/control-plane` (FR-003, FR-004 in spec — out of scope for this PR)
- **Prerequisite merged**: PR #573 (shared-packages mount fix)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Still getting 404 | Control-plane process not running | Check cluster-base companion PR is deployed |
| 502 from relay | Socket file doesn't exist | Verify `/run/generacy-control-plane/control.sock` exists in container |
| Route not matching | Prefix mismatch | Confirm cloud sends `/control-plane/...` path (not `/api/control-plane/...`) |
