# Quickstart: Forward Registry Credentials to Credhelper

## What This Does

After `generacy launch` pulls a private Docker image, this feature automatically forwards the registry credentials into the cluster's encrypted credential store. This means future `generacy update` commands can re-pull the image without re-prompting for credentials.

## Prerequisites

- Sibling issue #641 implemented (pull with scoped credentials)
- Control-plane `/credentials` route accepting `registry` type
- `curl` available in cluster-base image

## How It Works

1. Cloud includes `registryCredentials` array in LaunchConfig response
2. CLI pulls image using scoped `.generacy/.docker/config.json` (sibling issue)
3. After cluster starts and control-plane is ready, CLI forwards credentials
4. On success, scoped Docker config is deleted (no plaintext creds on disk)

## Testing

```bash
# Run unit tests for the new module
cd packages/generacy
pnpm test -- credential-forward

# Integration test (requires running cluster)
GENERACY_LAUNCH_STUB=1 pnpm exec generacy launch --claim=test-claim
```

## Manual Verification

```bash
# After launch, verify no scoped Docker config remains
ls <projectDir>/.generacy/.docker/  # Should not exist

# Verify credential stored in cluster
docker compose -f .generacy/docker-compose.yml exec -T orchestrator \
  curl -sf --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/credentials/registry-ghcr.io
```

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Control-plane not ready within 20s | Warning logged, launch continues, scoped config retained |
| PUT returns error | Warning logged, launch continues, scoped config retained |
| `registryCredentials` absent from LaunchConfig | Step skipped entirely (no-op) |
| Scoped Docker config already deleted | `cleanupScopedDockerConfig` is idempotent (no error) |

## Troubleshooting

**"Control-plane not ready — skipping credential forward"**
- The cluster took too long to initialize. Credentials can be re-entered via the cloud dashboard.

**"Failed to forward credentials for: registry-X"**
- The control-plane rejected the PUT. Check cluster logs: `docker compose -f .generacy/docker-compose.yml logs control-plane`

**Scoped Docker config still present after launch**
- Credential forwarding failed or was skipped. Safe to delete manually: `rm -rf <projectDir>/.generacy/.docker/`
