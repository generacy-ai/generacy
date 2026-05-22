# Quickstart: Worker Scale Lifecycle Action

## Prerequisites

- Docker CLI + Compose V2 plugin installed in cluster-base container (companion PR)
- `ORCHESTRATOR_INTERNAL_API_KEY` set in environment (for metadata refresh IPC)
- Host docker socket mounted at `/var/run/docker-host.sock`

## Testing Locally

### 1. Run the control-plane tests

```bash
cd packages/control-plane
pnpm test
```

### 2. Run the orchestrator tests

```bash
cd packages/orchestrator
pnpm test
```

### 3. Manual test with curl (against running cluster)

```bash
# Scale workers to 3
curl -X POST http://localhost:3100/control-plane/lifecycle/worker-scale \
  -H "Content-Type: application/json" \
  -H "x-generacy-actor-user-id: test-user" \
  -d '{"count": 3}'

# Expected response:
# {"accepted":true,"action":"worker-scale","previousCount":1,"requestedCount":3}

# Verify via docker compose
docker compose -f .generacy/docker-compose.yml ps --format json | jq '.[].Name' | grep worker
```

### 4. Trigger metadata refresh manually

```bash
curl -X POST http://localhost:3100/internal/refresh-metadata \
  -H "Authorization: Bearer $ORCHESTRATOR_INTERNAL_API_KEY"

# Expected: {"accepted":true}
```

## API Reference

### POST /lifecycle/worker-scale

**Request body**:
```json
{ "count": 3 }
```

**Success response** (200):
```json
{
  "accepted": true,
  "action": "worker-scale",
  "previousCount": 1,
  "requestedCount": 3
}
```

**Error responses**:
- 400 `INVALID_BODY` — `count` missing, not integer, or < 1
- 500 `DOCKER_CLI_UNAVAILABLE` — Docker compose not found in container
- 500 `SCALE_FAILED` — Docker compose command failed (details in response)

### POST /internal/refresh-metadata

**Auth**: Bearer token (`ORCHESTRATOR_INTERNAL_API_KEY`)

**Success response** (200):
```json
{ "accepted": true }
```

**Error responses**:
- 401 — Missing or invalid API key
- 503 — Relay bridge not yet initialized

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `UNKNOWN_ACTION` 400 | `worker-scale` not in schema | Rebuild control-plane |
| `DOCKER_CLI_UNAVAILABLE` | cluster-base missing docker | Apply companion PR to cluster-base |
| Workers don't appear in UI | Metadata refresh failed | Check `ORCHESTRATOR_INTERNAL_API_KEY` is set in both processes |
| `ENOENT` on docker compose | Wrong compose file path | Check `resolveGeneracyDir()` resolution; set `GENERACY_PROJECT_DIR` env |
| Count reverts after restart | `.env` not persisted | Verify `.env` file was updated (not just `--scale` flag) |
