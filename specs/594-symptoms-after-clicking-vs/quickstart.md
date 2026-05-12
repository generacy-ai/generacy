# Quickstart: Control-plane relay event IPC channel

**Feature**: #594 — Control-plane relay events silently dropped
**Date**: 2026-05-12

## Prerequisites

- Node.js >= 22
- pnpm
- Docker (for integration testing with cluster-base)

## Build

```bash
# From repo root
pnpm install
pnpm -r build
```

## What Changed

Two packages modified:

1. **`packages/orchestrator`** — New `POST /internal/relay-events` endpoint + API key registration
2. **`packages/control-plane`** — Entry point wires `setRelayPushEvent()` with HTTP callback

One companion repo:

3. **`cluster-base`** — Entrypoint script generates `ORCHESTRATOR_INTERNAL_API_KEY` env var

## Verification

### Unit test: orchestrator endpoint

```bash
cd packages/orchestrator
pnpm test -- --grep "relay-events"
```

### Unit test: control-plane callback wiring

```bash
cd packages/control-plane
pnpm test -- --grep "relay-events"
```

### Manual integration test (with Docker cluster)

1. Start a cluster with the updated images
2. Exec into the orchestrator container:
   ```bash
   docker exec -it <container> bash
   ```
3. Verify the env var exists:
   ```bash
   echo $ORCHESTRATOR_INTERNAL_API_KEY
   # Should print a UUID
   ```
4. Verify the control-plane is wired:
   ```bash
   grep -c "setRelayPushEvent" /proc/$(pgrep -f control-plane)/cmdline 2>/dev/null
   # Or check logs:
   docker logs <container> 2>&1 | grep "relay event"
   ```
5. Trigger "Start Tunnel" in the bootstrap wizard UI
6. Check cloud-side SSE for `cluster:vscode-tunnel` events
7. Verify device code appears in the wizard dialog within ~5s

### Diagnostic commands

```bash
# Verify no silent drops — should NOT see this warning in logs:
docker logs <container> 2>&1 | grep "ORCHESTRATOR_INTERNAL_API_KEY not set"

# Verify events reach orchestrator:
docker logs <container> 2>&1 | grep "relay-events"

# Verify relay sends events:
docker logs <container> 2>&1 | grep "cluster.vscode-tunnel"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "ORCHESTRATOR_INTERNAL_API_KEY not set" warning in logs | cluster-base companion PR not merged | Merge cluster-base PR; ensure entrypoint exports the key |
| Events reach orchestrator but not cloud | Relay not connected | Check relay connection status in orchestrator logs |
| 401 on `/internal/relay-events` | Key mismatch | Verify both processes see the same `ORCHESTRATOR_INTERNAL_API_KEY` |
| Events fire but device code doesn't appear in UI | Cloud-side SSE routing issue | Check generacy-cloud#543 is deployed |
| code-server metadata stopped working | Regression in #586 path | code-server uses `onStatusChange` → `sendMetadata()` (separate path, should be unaffected) |
