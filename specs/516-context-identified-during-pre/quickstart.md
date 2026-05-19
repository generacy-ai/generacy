# Quickstart: Dynamic /state Endpoint

## What Changed

The control-plane `GET /state` endpoint now returns real deployment configuration and lifecycle status instead of hardcoded values.

## Environment Variables

Set these on the control-plane container:

```bash
# Deployment mode — determines cloud UI behavior
DEPLOYMENT_MODE=cloud   # or 'local' (default)

# Cluster variant
CLUSTER_VARIANT=cluster-base   # or 'cluster-microservices' (default: cluster-base)
```

## Verifying the Endpoint

```bash
# Query state via Unix socket
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/state
```

Expected response after startup (before orchestrator pushes ready):
```json
{
  "status": "bootstrapping",
  "deploymentMode": "cloud",
  "variant": "cluster-base",
  "lastSeen": "2026-04-30T12:00:00.000Z"
}
```

## Pushing Status Updates (Orchestrator → Control-Plane)

```bash
# Push a status transition
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/internal/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "ready"}'
```

```bash
# Push degraded with reason
curl --unix-socket /run/generacy-control-plane/control.sock \
  -X POST http://localhost/internal/status \
  -H 'Content-Type: application/json' \
  -d '{"status": "degraded", "statusReason": "Relay disconnected — retrying"}'
```

## Testing

```bash
cd packages/control-plane
pnpm test
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| State always shows `bootstrapping` | Orchestrator not pushing status | Check orchestrator logs for relay handshake |
| `deploymentMode: 'local'` on cloud | `DEPLOYMENT_MODE` env var not set | Set in container entrypoint or docker-compose |
| `POST /internal/status` returns 400 | Invalid status value or malformed JSON | Check body matches `StatusUpdateSchema` |
| State stuck in `error` | Terminal state by design | Restart the control-plane container |
