# Quickstart: BackendClient Factory (Phase 7a)

## Prerequisites

- Node.js 20+
- pnpm installed
- `packages/credhelper-daemon` built (`pnpm build` from repo root)

## Configuration

### 1. Set up `.agency/secrets/backends.yaml`

```yaml
schemaVersion: '1'
backends:
  - id: env-local
    type: env
```

### 2. Set up `.agency/secrets/credentials.yaml`

```yaml
schemaVersion: '1'
credentials:
  - id: github-token
    type: github-pat
    backend: env-local
    backendKey: GITHUB_TOKEN
```

### 3. Set the environment variable

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4. Create a role in `.agency/roles/ci-runner.yaml`

```yaml
schemaVersion: '1'
id: ci-runner
description: CI runner with GitHub access
credentials:
  - ref: github-token
    expose:
      - as: env
        name: GITHUB_TOKEN
```

## Running the Daemon

```bash
cd packages/credhelper-daemon
CREDHELPER_AGENCY_DIR=/path/to/.agency pnpm start
```

## Testing Credential Resolution

```bash
# Begin a session
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X POST http://localhost/sessions \
  -H 'Content-Type: application/json' \
  -d '{"role": "ci-runner", "session_id": "test-1"}'

# Check the rendered env file
cat /run/generacy-credhelper/sessions/test-1/env
# Output: GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# End the session
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X DELETE http://localhost/sessions/test-1
```

## Running Tests

```bash
# Unit tests only
pnpm --filter @generacy-ai/credhelper-daemon test -- --grep "backends"

# Integration tests
pnpm --filter @generacy-ai/credhelper-daemon test -- --grep "env-backend-session"

# All tests
pnpm --filter @generacy-ai/credhelper-daemon test
```

## Supported Backend Types

| Type | Status | Description |
|------|--------|-------------|
| `env` | Working | Reads secrets from `process.env` |
| `generacy-cloud` | Stub (Phase 7b) | Throws `NotImplementedError` — use `env` for now |

## Troubleshooting

### "Environment variable 'X' is not set"

The `env` backend can't find the specified `backendKey` in `process.env`. Ensure the variable is exported in the daemon's environment:

```bash
export MY_SECRET=value
```

### "generacy-cloud backend not yet implemented"

The `generacy-cloud` backend is a placeholder. Switch to `type: env` in `backends.yaml` until Phase 7b lands.

### "Unknown backend type 'X'"

The `type` field in `backends.yaml` must be `env` or `generacy-cloud`. Check for typos.
