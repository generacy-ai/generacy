# Quickstart: Verifying Background Activation Fix

**Branch**: `567-problem-wizard-mode-generacy`

## What Changed

The orchestrator no longer blocks HTTP server startup while waiting for device-code activation approval. The activation polling runs in the background, allowing the healthcheck to pass immediately.

## Verification Steps

### 1. Run the test suite

```bash
cd packages/orchestrator
pnpm test
```

### 2. Verify healthcheck in wizard mode (manual)

```bash
# Start the development stack with wizard mode
GENERACY_BOOTSTRAP_MODE=wizard docker compose up -d

# Health endpoint should respond within 15 seconds
time curl -f http://localhost:3100/health
# Expected: {"status":"ok"} in < 15s

# Worker container should be healthy
docker compose ps
# Expected: both orchestrator and worker show "healthy"
```

### 3. Verify activation flow (manual, requires cloud)

```bash
# Watch orchestrator logs for activation instructions
docker compose logs -f orchestrator

# Expected sequence:
# 1. "Checking for existing cluster API key"
# 2. Server starts listening on :3100
# 3. "Go to: <verification_uri>"  (background)
# 4. After browser approval: "Cluster activated successfully"
# 5. "Relay bridge configured"
# 6. "Relay bridge started"
```

### 4. Verify non-wizard mode is unchanged

```bash
# With existing key file, activation is synchronous (fast path)
# Relay bridge should initialize during createServer() as before
docker compose up -d
docker compose logs orchestrator | grep "Relay bridge"
# Expected: "Relay bridge configured" appears before "Server listening"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Healthcheck still timing out | Change not applied; check image rebuild | `docker compose build orchestrator` |
| "Cluster activation skipped" in logs | Activation failed (expected); relay bridge won't start | Check cloud connectivity, retry activation |
| Relay bridge never starts after approval | Background init failed; check orchestrator error logs | Look for `initializeRelayBridge` errors |
