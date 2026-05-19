# Quickstart: #614 Stale Credential Surface After Cluster Re-Add

## What This Fixes

After archiving a cluster in the cloud UI and re-adding it with `npx generacy launch --claim=<new-code>`, the orchestrator's GitHub API calls no longer 401 forever. Two root causes are fixed:

1. **Live credential refresh**: When the cloud pushes a new GitHub credential, the cluster now updates both the env file (for restarts) and `gh` auth state (for immediate use).
2. **Clean re-activation**: The CLI clears stale activation files from the Docker volume when `--claim` is provided, ensuring the orchestrator runs a fresh activation flow.

## Development Setup

```bash
pnpm install
pnpm dev
```

For Firebase emulators:
```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
```

## Running Tests

```bash
# Control-plane tests (Fix A)
pnpm --filter @generacy-ai/control-plane test

# CLI tests (Fix B)
pnpm --filter @generacy-ai/generacy test
```

## Manual Verification

### Fix A — Credential Live-Refresh

1. Start a running cluster with a valid relay connection
2. PUT a new credential:
   ```bash
   curl -X PUT http://localhost:3100/control-plane/credentials/github-main-org \
     -H 'Content-Type: application/json' \
     -H 'x-generacy-actor-user-id: test' \
     -d '{"type":"github-app","value":"{\"installationId\":1,\"token\":\"ghs_newtoken\"}"}'
   ```
3. Verify `/var/lib/generacy/wizard-credentials.env` contains `GH_TOKEN=ghs_newtoken`
4. Verify `gh auth status` shows the new token
5. Verify orchestrator's next `gh` API call succeeds

### Fix B — Clean Re-Activation

1. Run `npx generacy launch --claim=<old>` to set up a cluster
2. Archive the cluster in the cloud UI
3. Run `npx generacy launch --claim=<new>` pointing to the same project directory
4. Observe: stale `cluster-api-key` removed from volume, orchestrator runs fresh activation
5. Wizard credentials arrive, orchestrator can make authenticated GitHub calls

## Troubleshooting

### `gh auth login` fails in container
- Check: is `gh` installed in the cluster image? (`which gh` in container)
- Non-fatal: the env file is still updated, so next container restart will work
- Log message: `"Failed to refresh gh auth"` at warn level

### Volume cleanup fails
- Check: Docker must be running (`docker info`)
- Check: Volume name must match compose project name (`docker volume ls | grep generacy-data`)
- The cleanup uses `rm -f` (no error on missing files) — it's safe to re-run

### Activation still skipped after re-launch
- Verify: `docker volume ls` shows the volume exists
- Verify: `docker run --rm -v <name>_generacy-data:/v alpine ls /v/` — `cluster-api-key` should NOT be present
- If key file persists: compose project name may have changed between launches. Check `.generacy/docker-compose.yml` for the `name:` field.
