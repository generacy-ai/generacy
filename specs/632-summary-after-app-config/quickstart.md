# Quickstart: App-Config Secrets Env Renderer

## What It Does

Renders app-config secrets from the encrypted backend into `/run/generacy-app-config/secrets.env` so running processes can source them alongside the existing plaintext env file.

## How It Works

1. **At boot**: Control-plane daemon unseals all `secret: true` entries from `values.yaml` metadata, decrypts each via `ClusterLocalBackend`, writes combined `secrets.env`
2. **On PUT**: When a secret env var is set via the API, `secrets.env` is atomically rewritten
3. **On DELETE**: Entry removed from `secrets.env`
4. **On flag change**: If a var transitions between secret/non-secret, it's moved between files automatically

## For Process Consumers

Source both env files:

```bash
set -a
source /var/lib/generacy-app-config/env           # non-secrets
source /run/generacy-app-config/secrets.env        # secrets
set +a
```

Or in Docker Compose:

```yaml
services:
  my-service:
    env_file:
      - /var/lib/generacy-app-config/env
      - /run/generacy-app-config/secrets.env
```

## File Locations

| File | Purpose | Storage |
|---|---|---|
| `/var/lib/generacy-app-config/env` | Non-secret env vars | Persistent volume |
| `/run/generacy-app-config/secrets.env` | Secret env vars (plaintext) | tmpfs (memory-only) |
| `/var/lib/generacy/credentials.dat` | Encrypted source of truth | Persistent volume |
| `/var/lib/generacy-app-config/values.yaml` | Metadata (which vars exist, secret flag) | Persistent volume |

## Verifying

```bash
# Check secrets file exists and has content
docker exec <orchestrator> cat /run/generacy-app-config/secrets.env

# Verify a specific secret
docker exec <orchestrator> sh -c \
  'set -a; source /run/generacy-app-config/secrets.env; echo $SERVICE_ANTHROPIC_API_KEY'

# Check store status in init result
docker exec <orchestrator> cat /run/generacy-control-plane/init-result.json | jq .stores.appConfigSecretEnv
```

## Degraded States

| Status | Meaning | User Impact |
|---|---|---|
| `ok` | Using `/run/generacy-app-config/secrets.env` | Full functionality |
| `fallback` | Using `/tmp/generacy-app-config/secrets.env` | Works, but secrets may persist to disk |
| `disabled` | Neither path writable | Secrets stored in backend but not rendered to env file |

Check status via relay metadata or `init-result.json`. Cloud UI displays degraded state when applicable.

## Troubleshooting

**Secrets file is empty or missing**:
- Check `init-result.json` for `appConfigSecretEnv` status
- If `disabled`: verify `/run/generacy-app-config/` tmpfs mount exists (cluster-base#38)
- If `fallback`: check logs for "secrets file falling back to /tmp" warning

**Secret set via UI but not in env file**:
- Verify `values.yaml` shows the entry with `secret: true`
- Check `credentials.dat` has the encrypted value (via credhelper logs)
- Restart control-plane to trigger boot-time re-render

**Partial render at boot**:
- Some secrets may fail to unseal (corrupted entry, key rotation)
- Check logs for per-entry warnings
- Successfully unsealed entries are still written (best-effort)
