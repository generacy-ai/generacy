# Quickstart: Verifying #626 Fix

## Run Tests

```bash
cd packages/control-plane
pnpm test
```

The three updated test cases in `__tests__/routes/app-config.test.ts` validate:
1. Bare `null` response when no manifest
2. Bare `{ schemaVersion, env, files }` when manifest present
3. Bare `null` when `cluster.yaml` doesn't exist

## Manual Verification (staging)

1. Start a cluster with an `appConfig` block in `cluster.yaml`
2. `curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/app-config/manifest`
3. Verify response is `{"schemaVersion":"1","env":[...],"files":[...]}` — no `{ appConfig: ... }` wrapper
4. Open the bootstrap wizard — AppConfigStep should render without TypeError
