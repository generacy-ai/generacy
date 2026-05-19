# Testing Guide: Wizard-mode relay bridge initialization fix

**Branch**: `598-symptoms-after-creating-fresh`

## Prerequisites

- Docker and Docker Compose installed
- Access to a Generacy cloud environment (or stub mode)
- A fresh project (no existing `.generacy/cluster.json` with API key)

## Verification Steps

### 1. Wizard-mode startup (primary fix)

```bash
# Start a fresh cluster in wizard mode (no pre-existing API key)
generacy launch --claim=<code>

# Or manually: ensure no /var/lib/generacy/cluster-api-key exists
# and GENERACY_BOOTSTRAP_MODE=wizard
docker compose up -d
```

**Expected**: Orchestrator starts without errors. Check logs:
```bash
docker compose logs orchestrator | grep -E "Relay bridge|relay-events"
```

- Should see: `Control-plane relay event IPC endpoint registered` (at startup, before activation)
- Should NOT see: `Relay bridge not available`
- After activation completes: `Relay bridge configured`, `Relay connected to cloud`

### 2. Pre-activation 503 behavior

Before activation completes, test the route returns 503:
```bash
curl -s -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $ORCHESTRATOR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel":"cluster.bootstrap","payload":{}}' \
  http://127.0.0.1:3100/internal/relay-events
```

**Expected**: HTTP 503 with `{ "error": "relay not yet initialized" }`

### 3. Post-activation relay event forwarding

After activation completes:
```bash
curl -s -w "%{http_code}" -X POST \
  -H "Authorization: Bearer $ORCHESTRATOR_INTERNAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"channel":"cluster.bootstrap","payload":{"test":true}}' \
  http://127.0.0.1:3100/internal/relay-events
```

**Expected**: HTTP 204 (no content)

### 4. Bootstrap wizard completion

1. Open the cloud dashboard wizard for the new cluster
2. Complete credential setup and repo cloning steps
3. Verify the "Ready" step shows online status (not "Cluster is not reachable")
4. Verify no 404 errors on `/control-plane/*` routes in browser network tab

### 5. Non-wizard mode regression check

```bash
# Start a cluster that already has an API key (non-wizard mode)
# e.g., an existing activated cluster
docker compose up -d
docker compose logs orchestrator | grep "Relay bridge"
```

**Expected**: Same behavior as before — `Relay bridge configured` appears during startup, relay connects immediately.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Cannot add route when fastify instance is already started" | Route still registered in `initializeRelayBridge()` | Ensure `setupInternalRelayEventsRoute` is called only in `createServer()`, before `server.listen()` |
| 401 on `/internal/relay-events` | API key not in store | Verify `ORCHESTRATOR_INTERNAL_API_KEY` env var is set and key is added to `apiKeyStore` before `listen()` |
| 503 persists after activation | `relayClientRef` not being assigned | Check that `initializeRelayBridge` calls the setter callback with the new client |
