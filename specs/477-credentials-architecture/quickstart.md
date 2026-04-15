# Quickstart: Wire Credhelper Daemon Config Loader

## Prerequisites

- Node.js 20+
- pnpm 9+
- Built workspace: `pnpm install && pnpm build`

## Testing the Integration

### 1. Run unit/integration tests

```bash
cd packages/credhelper-daemon
pnpm test
```

### 2. Run just the config-loading integration test

```bash
cd packages/credhelper-daemon
pnpm vitest run __tests__/integration/config-loading.test.ts
```

### 3. Manual verification

Create a minimal `.agency/` directory:

```bash
mkdir -p /tmp/test-agency/secrets /tmp/test-agency/roles
```

Write `secrets/backends.yaml`:
```yaml
schemaVersion: "1"
backends:
  - id: github
    type: github-app
    endpoint: https://api.github.com
```

Write `secrets/credentials.yaml`:
```yaml
schemaVersion: "1"
credentials:
  - id: gh-token
    type: github-pat
    backend: github
    backendKey: default
```

Write `roles/ci-runner.yaml`:
```yaml
schemaVersion: "1"
id: ci-runner
description: CI runner role
credentials:
  - ref: gh-token
    expose:
      - as: env
        name: GITHUB_TOKEN
```

Start the daemon:
```bash
CREDHELPER_AGENCY_DIR=/tmp/test-agency \
CREDHELPER_CONTROL_SOCKET=/tmp/credhelper-test.sock \
CREDHELPER_SESSIONS_DIR=/tmp/credhelper-sessions \
node packages/credhelper-daemon/dist/bin/credhelper-daemon.js
```

### 4. Verify fail-closed behavior

Start with invalid config (missing backend reference):
```bash
# Modify credentials.yaml to reference a nonexistent backend
CREDHELPER_AGENCY_DIR=/tmp/test-agency-bad \
node packages/credhelper-daemon/dist/bin/credhelper-daemon.js
# Expected: exits non-zero with validation error
```

## Verification Checklist

- [ ] `grep 'not yet integrated' packages/credhelper-daemon/` returns no matches
- [ ] Daemon starts against valid `.agency/` directory
- [ ] Daemon exits non-zero against invalid config
- [ ] All existing tests still pass: `pnpm test --filter @generacy-ai/credhelper-daemon`
