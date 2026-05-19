# Quickstart: Remove cloud-side credential storage and OIDC code

**Feature**: #488 | **Date**: 2026-04-28

## Verification Steps

After implementation, verify the removal is complete and correct:

### 1. No dangling imports

```bash
# From repo root — should return zero results
grep -r "generacy-cloud-backend" packages/credhelper-daemon/src/
grep -r "session-token-store" packages/credhelper-daemon/src/
grep -r "jwt-parser" packages/credhelper-daemon/src/
grep -r "SessionTokenStore" packages/credhelper-daemon/src/
grep -r "JwtParser" packages/credhelper-daemon/src/
grep -r "GeneracyCloudBackend" packages/credhelper-daemon/src/
grep -r "generacy-cloud" packages/credhelper-daemon/src/
```

### 2. Deleted files are gone

```bash
# All should return "No such file or directory"
ls packages/credhelper-daemon/src/auth/jwt-parser.ts
ls packages/credhelper-daemon/src/auth/session-token-store.ts
ls packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts
ls packages/credhelper-daemon/__tests__/auth/jwt-parser.test.ts
ls packages/credhelper-daemon/__tests__/auth/session-token-store.test.ts
ls packages/credhelper-daemon/__tests__/backends/generacy-cloud-backend.test.ts
ls packages/credhelper-daemon/__tests__/integration/session-token-flow.test.ts
```

### 3. Build succeeds

```bash
pnpm build
```

### 4. Tests pass

```bash
pnpm test
```

### 5. Backend factory error message updated

Verify the error message in `src/backends/factory.ts` references `cluster-local` and `env`:
```bash
grep -n "cluster-local" packages/credhelper-daemon/src/backends/factory.ts
```

### 6. jose dependency removed

```bash
grep "jose" packages/credhelper-daemon/package.json
# Should return zero results
```

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Build fails with missing import | Dangling reference to deleted module | Search for the import path and remove it |
| Test fails referencing `SessionTokenStore` | Test file still mocks deleted type | Remove the mock and related test cases |
| `jose` still in lockfile | `pnpm install` not run after removal | Run `pnpm install` to regenerate lockfile |
