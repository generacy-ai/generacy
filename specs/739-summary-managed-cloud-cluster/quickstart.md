# Quickstart: Pre-Approved Device Code Activation

**Issue**: [#739](https://github.com/generacy-ai/generacy/issues/739)
**Branch**: `739-summary-managed-cloud-cluster`

## Build

```bash
pnpm install
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/generacy build
```

## Automated tests

```bash
# Orchestrator activation unit tests
pnpm --filter @generacy-ai/orchestrator test tests/unit/activation/index.test.ts

# CLI scaffolder tests
pnpm --filter @generacy-ai/generacy test src/cli/commands/cluster/__tests__/scaffolder.test.ts
```

Expected: all existing tests pass; new cases for pre-approved branch + scaffolder env-line pass.

## Manual verification

### Scenario 1: Pre-approved code is consumed (happy path)

**Setup**: Run a local cloud (or stub `/api/clusters/device-code/poll` to return `approved` immediately).

```bash
# Simulate a pre-approved code by exporting before orchestrator starts
export GENERACY_PRE_APPROVED_DEVICE_CODE='dc_test_preapproved_abc123'
export GENERACY_API_URL='http://localhost:3001'

# Start orchestrator (no key file present)
rm -f /var/lib/generacy/cluster-api-key
node packages/orchestrator/dist/server.js
```

**Expected stdout (JSON pino lines)**:
```json
{"level":30,"event":"activation-start","mode":"pre-approved","msg":"…"}
{"level":30,"msg":"Cluster activated via pre-approved device code"}
```

**Negative assertions**:
- No `"Cluster Activation Required"` block printed.
- No `"Requesting device code (cycle 1/3)"` log line.
- `echo $GENERACY_PRE_APPROVED_DEVICE_CODE` from the orchestrator process is empty after activation (verifiable in a test, not in the shell).
- `/var/lib/generacy/cluster-api-key` exists and contains the cloud-returned key.

### Scenario 2: Terminal failure falls back to interactive

**Setup**: Set an expired/invalid device code.

```bash
export GENERACY_PRE_APPROVED_DEVICE_CODE='dc_expired_xyz'
rm -f /var/lib/generacy/cluster-api-key
node packages/orchestrator/dist/server.js
```

**Expected stdout**:
```json
{"level":30,"event":"activation-start","mode":"pre-approved"}
{"level":40,"msg":"Pre-approved device code redemption failed (terminal); falling back to interactive flow"}
{"level":30,"event":"activation-start","mode":"interactive"}
{"level":30,"msg":"Requesting device code (cycle 1/3)"}
```

Followed by the existing `Cluster Activation Required` block with a freshly minted `user_code`.

### Scenario 3: No pre-approved code → unchanged behavior

```bash
unset GENERACY_PRE_APPROVED_DEVICE_CODE
rm -f /var/lib/generacy/cluster-api-key
node packages/orchestrator/dist/server.js
```

**Expected stdout**:
```json
{"level":30,"event":"activation-start","mode":"interactive"}
{"level":30,"msg":"Requesting device code (cycle 1/3)"}
```

Followed by the existing `Cluster Activation Required` block. Identical to pre-change behavior.

### Scenario 4: Restart with existing key file → activation skipped

```bash
# After any successful run, the key file exists
ls /var/lib/generacy/cluster-api-key
# restart
node packages/orchestrator/dist/server.js
```

**Expected stdout**:
```json
{"level":30,"msg":"Existing cluster API key found, skipping activation"}
```

No `activation-start` log line (the existing-key branch returns before the new branch is reached). This is by design — the device-code env var is irrelevant once the cluster is activated.

## CLI verification

### `generacy launch` with a cloud-provided pre-approved code

```bash
# Stubbed LaunchConfig — set GENERACY_LAUNCH_STUB=1 if cloud isn't available
generacy launch --claim TEST-CLAIM-CODE --dir /tmp/test-cluster
```

After launch completes (or after the docker compose up step), inspect:

```bash
grep PRE_APPROVED /tmp/test-cluster/.generacy/.env
```

**Expected** (if cloud returned `preApprovedDeviceCode` in `LaunchConfig`):
```
GENERACY_PRE_APPROVED_DEVICE_CODE=dc_abc123...
```

**Expected** (cloud did not return it — backwards compat): no `PRE_APPROVED` line.

### `generacy deploy ssh://…` with pre-approved code

```bash
generacy deploy ssh://user@host/path
ssh user@host 'grep PRE_APPROVED /path/.generacy/.env'
```

Same expectation as `launch`.

## Troubleshooting

### Cluster still stuck at "Connecting" on a managed deploy

1. SSH into the droplet: `doctl compute ssh <droplet-id>`
2. Inspect the env file: `grep PRE_APPROVED /opt/generacy/.env`
   - If the line is missing → the cloud-side companion fix in generacy-cloud is not deployed.
   - If the line is present → continue to step 3.
3. Tail orchestrator logs: `docker logs -f generacy-orchestrator | grep activation`
   - Look for `{"event":"activation-start","mode":"pre-approved"}` — confirms the new branch ran.
   - Look for "Pre-approved device code redemption failed" — confirms terminal failure (likely expired due to slow droplet provisioning).
4. If the code expired, the orchestrator should have fallen through to interactive flow. Look for `{"event":"activation-start","mode":"interactive"}` and the `Cluster Activation Required` prompt with a fresh code — paste that into the browser to recover manually.

### `process.env` cleanup didn't happen

This is observable only from inside the orchestrator process. If you suspect leakage:
1. Confirm the activation succeeded (key file exists at `/var/lib/generacy/cluster-api-key`).
2. The `delete` runs synchronously between `writeKeyFile` and the `return` statement; failure here would indicate the success path didn't run, which would also mean activation didn't complete.

### Device code being logged

The orchestrator never logs the device code value (only its presence via `mode: 'pre-approved'`). If you see one in logs, that's a regression — search for any new `logger.*` calls that include `preApprovedDeviceCode` or `process.env.GENERACY_PRE_APPROVED_DEVICE_CODE` and remove them.
