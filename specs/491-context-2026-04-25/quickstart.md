# Quickstart: Cluster-Local Credhelper Backend

**Feature**: #491 | **Date**: 2026-04-28

## Prerequisites

- Node.js >= 20
- pnpm (workspace dependencies)
- The credhelper-daemon package built: `pnpm --filter @generacy-ai/credhelper-daemon build`

## Development Setup

```bash
# Install dependencies
pnpm install

# Build the shared types package first (dependency)
pnpm --filter @generacy-ai/credhelper build

# Build the daemon package
pnpm --filter @generacy-ai/credhelper-daemon build
```

## Running Tests

```bash
# Run all credhelper-daemon tests
pnpm --filter @generacy-ai/credhelper-daemon test

# Run only cluster-local backend tests
pnpm --filter @generacy-ai/credhelper-daemon test -- --grep "cluster-local"

# Run with verbose output
pnpm --filter @generacy-ai/credhelper-daemon test -- --reporter=verbose
```

## Key Files

| File | Purpose |
|------|---------|
| `packages/credhelper/src/types/context.ts` | `WritableBackendClient` interface |
| `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` | Backend implementation |
| `packages/credhelper-daemon/src/backends/crypto.ts` | AES-256-GCM encrypt/decrypt |
| `packages/credhelper-daemon/src/backends/file-store.ts` | Atomic file I/O + locking |
| `packages/credhelper-daemon/src/backends/factory.ts` | Factory with `cluster-local` case |

## Configuration

The cluster-local backend is the default when no explicit backend type is configured. To use it explicitly in `.agency/backends.yaml`:

```yaml
schemaVersion: "1"
backends:
  - id: local
    type: cluster-local
```

If `type` is omitted, the config loader fills in `cluster-local` automatically.

## File Locations

| File | Path | Permissions |
|------|------|-------------|
| Master key | `/var/lib/generacy/master.key` | 0600, uid 1002 |
| Credential store | `/var/lib/generacy/credentials.dat` | 0600 |

Both files live on a persistent named volume that survives container restarts.

## Manual Testing (with daemon running)

```bash
# Start the dev stack (Firebase emulators + services)
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh

# The credhelper daemon starts as part of the stack
# Verify the backend is initialized:
curl --unix-socket /run/generacy-credhelper/control.sock http://localhost/health
```

## Troubleshooting

### "CREDENTIAL_STORE_CORRUPT" error on startup
The `credentials.dat` file contains invalid JSON. The backend refuses to start (fail-closed). Recovery: delete the file and re-enter credentials via the bootstrap UI.

### "CREDENTIAL_STORE_MIGRATION_NEEDED" error
The `credentials.dat` file has an unrecognized `version` field. This means the file was written by a newer version of the daemon. Upgrade the daemon or delete and re-enter.

### Master key permission denied
The master key file at `/var/lib/generacy/master.key` must be mode 0600 and owned by uid 1002 (the credhelper daemon user). Fix with:
```bash
chmod 0600 /var/lib/generacy/master.key
chown 1002:1002 /var/lib/generacy/master.key
```

### Lost master key
If the master key file is deleted or the volume is lost, all encrypted credentials are unrecoverable. Delete `credentials.dat` and re-enter credentials through the bootstrap UI. This is the v1.5 recovery model (destroy-and-reenter). Key rotation is planned for a future release.
