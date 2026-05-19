# Quickstart: Credhelper Daemon

## Installation

```bash
# From the monorepo root
cd /workspaces/generacy
pnpm install
pnpm --filter @generacy-ai/credhelper-daemon build
```

## Running the Daemon

### In a worker container (production)

The daemon is started by the container entrypoint as uid 1002:

```bash
# Started by entrypoint script, not manually
su -s /bin/sh credhelper -c 'node packages/credhelper-daemon/dist/bin/credhelper-daemon.js'
```

### For development/testing

```bash
# Build the types package first
pnpm --filter @generacy-ai/credhelper build

# Build and run the daemon
pnpm --filter @generacy-ai/credhelper-daemon build

# Run tests
pnpm --filter @generacy-ai/credhelper-daemon test

# Watch mode
pnpm --filter @generacy-ai/credhelper-daemon test:watch
```

## Control Socket API

### Begin a session

```bash
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X POST http://localhost/sessions \
  -H 'Content-Type: application/json' \
  -d '{"role": "developer", "sessionId": "sess-abc123"}'
```

Response:
```json
{
  "session_dir": "/run/generacy-credhelper/sessions/sess-abc123",
  "expires_at": "2026-04-13T15:30:00.000Z"
}
```

### End a session

```bash
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X DELETE http://localhost/sessions/sess-abc123
```

Response:
```json
{ "ok": true }
```

## Data Socket API

### Fetch a credential

```bash
curl --unix-socket /run/generacy-credhelper/sessions/sess-abc123/data.sock \
  http://localhost/credential/github-main-org
```

Response: raw token value (text/plain)

## Session Directory Layout

After `POST /sessions`, the session directory contains:

```
/run/generacy-credhelper/sessions/sess-abc123/
├── env                       # source this: export STRIPE_KEY=sk_...
├── git/
│   ├── config                # [credential] helper = !./credential-helper
│   └── credential-helper     # shell script → queries data.sock
├── gcp/
│   └── external-account.json # credential_source.url → data.sock
└── data.sock                 # per-session credential server
```

## Error Responses

All errors return JSON with HTTP status codes:

```json
{
  "error": "Plugin 'github-app' failed to mint credential 'github-main-org'",
  "code": "PLUGIN_MINT_FAILED",
  "details": {
    "pluginType": "github-app",
    "credentialId": "github-main-org"
  }
}
```

| Status | Meaning |
|--------|---------|
| 400 | Invalid request (bad role, unsupported exposure) |
| 404 | Session or credential not found |
| 410 | Credential expired |
| 501 | Exposure type not yet implemented (proxy types) |
| 502 | Backend/plugin failure |
| 500 | Internal daemon error |

## Troubleshooting

**Control socket connection refused**: Verify the daemon is running and the socket exists at `/run/generacy-credhelper/control.sock`. Check `ls -la` for correct ownership (should be owned by worker uid 1000, mode 0600).

**SO_PEERCRED rejection**: The connecting process UID doesn't match the expected worker UID (1000). Verify you're connecting from the correct user.

**Session begin fails with ROLE_NOT_FOUND**: The role ID doesn't match any YAML file in the config directory. Check the config loader and role files.

**Credential unavailable after refresh failure**: The background refresher failed to mint a new token. Check daemon logs for `PLUGIN_MINT_FAILED` entries. The credential remains unavailable until the session ends.

**Session auto-cleaned with warning**: The session expired without an explicit DELETE. This usually means the worker crashed or didn't clean up. Check worker logs for the matching session ID.
