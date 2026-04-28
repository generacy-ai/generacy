# Quickstart: Cluster Device-Flow Activation

## Overview

The activation module runs automatically on orchestrator boot. No manual invocation is needed.

## How It Works

1. Orchestrator starts
2. Activation module checks for `/var/lib/generacy/cluster-api-key`
3. If absent, it requests a device code from the cloud and prints:
   ```
   Cluster activation required.
   Visit: https://generacy.ai/cluster-activate?code=ABCD-1234
   Or enter code manually: ABCD-1234
   ```
4. Operator visits the URL and approves the cluster
5. Activation module detects approval, persists the key, and orchestrator proceeds to connect the relay

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GENERACY_CLOUD_URL` | No | Derived from relay URL | Base HTTP URL of the Generacy cloud |
| `GENERACY_API_KEY` | No | — | If set, activation is skipped (pre-provisioned key) |

**Precedence for cloud URL**: `GENERACY_CLOUD_URL` > derived from relay WebSocket URL > `https://api.generacy.ai`

## File Paths

| Path | Mode | Content |
|------|------|---------|
| `/var/lib/generacy/cluster-api-key` | `0600` | Raw API key (secret) |
| `/var/lib/generacy/cluster.json` | `0644` | Cluster metadata (non-secret) |

## Testing

### Run unit tests
```bash
cd packages/orchestrator
pnpm test -- src/activation/
```

### Run with a local cloud mock
```bash
# Set cloud URL to local server
GENERACY_CLOUD_URL=http://localhost:4000 pnpm dev
```

### Integration test
The integration test at `src/activation/__tests__/activate.test.ts` spins up a fake HTTP server that simulates the device-code endpoints. It covers:
- Happy path (immediate approval)
- `slow_down` response handling
- Device code expiry + auto-retry
- Cloud unreachable + retry exhaustion

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Activation failed: cloud unreachable" | Cannot reach `GENERACY_CLOUD_URL` | Check network, DNS, firewall. Verify URL with `curl $GENERACY_CLOUD_URL/api/clusters/device-code` |
| "Activation failed after 3 cycles" | Device code expired 3 times without approval | Ensure operator approves at the verification URL within the timeout |
| "Cannot write key file" | Permission denied on `/var/lib/generacy/` | Ensure directory exists and is writable by the `node` user |
| Activation runs every boot | Key file missing | Check if `/var/lib/generacy/` is on a persistent volume |
