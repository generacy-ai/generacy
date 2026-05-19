# Quickstart: Deploy SSH — Registry Credential Authentication

## Overview

After this feature, `generacy deploy ssh://...` transparently handles private registry authentication when deploying custom cluster images to remote VMs.

## Usage

### Deploy with Private Custom Image

No new CLI flags required. Credentials are provided by the cloud via `LaunchConfig.registryCredentials`:

```bash
# Deploy to remote VM — credentials handled automatically if custom image requires auth
generacy deploy ssh://user@myvm.example.com/opt/generacy
```

### Deploy with Default (Public) Image

No change — works exactly as before:

```bash
generacy deploy ssh://user@myvm.example.com
```

## What Happens Under the Hood

1. **Fetch config** — CLI gets `LaunchConfig` from cloud (includes `registryCredentials` if custom image)
2. **Write remote Docker config** — If credentials present, writes scoped `.docker/config.json` to remote
3. **Authenticated pull** — Runs `docker compose pull` with `DOCKER_CONFIG` pointing to scoped config
4. **Cleanup** — Immediately deletes remote Docker config (regardless of pull outcome)
5. **Start cluster** — `docker compose up -d`
6. **Wait for handshake** — Polls cloud until cluster is connected
7. **Forward to credhelper** — Pushes credentials into cluster's encrypted credential store
8. **Done** — Cluster running with persisted registry auth

## Error Scenarios

### Pull Authentication Failure

```
✖ Docker pull failed: unauthorized access to ghcr.io/my-org/custom-image
  Check that registry credentials are correct in your project settings at generacy.ai
```

The remote Docker config is still cleaned up. Fix credentials in the cloud UI and re-deploy.

### Credential Forward Failure (Soft Fail)

```
⚠ Could not forward registry credentials to cluster credhelper.
  Cluster is running. To add credentials manually:
  • Re-enter credentials at https://app.generacy.ai/clusters/<id>/settings
  • Or run: generacy registry-login --remote ssh://user@host
```

The deploy still exits 0 — cluster is operational, just needs credentials re-entered for future pulls.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `PULL_FAILED` with "unauthorized" | Invalid registry credentials | Update credentials in project settings on generacy.ai |
| `CREDENTIAL_WRITE_FAILED` | SSH write permission denied | Check remote user has write access to project directory |
| Forward warning but cluster works | Control-plane not ready in time | Re-enter credentials via cloud UI or `generacy registry-login` |
| Deploy works but container fails to pull later | Credentials not forwarded | Run `generacy registry-login --remote` to add credentials |

## Development

### Running Tests

```bash
cd packages/generacy
pnpm test -- --filter deploy
```

### Key Files

- `src/cli/commands/deploy/remote-credentials.ts` — Remote Docker config write/cleanup
- `src/cli/commands/deploy/credential-forward.ts` — Post-handshake forwarding via SSH
- `src/cli/commands/deploy/remote-compose.ts` — Modified to accept credentials for pull
- `src/cli/commands/deploy/index.ts` — Main orchestration (wires everything together)
