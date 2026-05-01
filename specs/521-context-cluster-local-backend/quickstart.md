# Quickstart: fd-based advisory lock for cluster-local backend

**Feature**: #521 | **Date**: 2026-05-01

## Prerequisites

- Node.js >=22 (required for `FileHandle.lock()`)
- pnpm installed

## Build

```bash
cd /workspaces/generacy
pnpm install
pnpm -C packages/credhelper-daemon build
```

## Run Tests

```bash
# All credhelper-daemon tests
pnpm -C packages/credhelper-daemon test

# Just the file-store tests
pnpm -C packages/credhelper-daemon test -- --reporter=verbose __tests__/backends/file-store.test.ts

# Just the cluster-local-backend integration tests
pnpm -C packages/credhelper-daemon test -- --reporter=verbose __tests__/backends/cluster-local-backend.test.ts
```

## Verification

### 1. Unit tests pass

```bash
pnpm -C packages/credhelper-daemon test
```

All existing tests should pass. The `file-store.test.ts` tests cover:
- Sequential save operations (existing)
- Lock file creation at `${dataPath}.lock` (new)
- Concurrent writes produce no corruption (new)

### 2. No new dependencies

```bash
git diff packages/credhelper-daemon/package.json
# Should show zero diff (no new dependencies added)
```

### 3. Lock file behavior

After a save operation, a zero-byte lock file exists at `${dataPath}.lock`:
```bash
ls -la /var/lib/generacy/credentials.dat.lock
# -rw-r--r-- 1 ... 0 ... credentials.dat.lock
```

## Troubleshooting

### `fh.lock is not a function`

Node.js version is below 22. Check with `node --version`. The `FileHandle.lock()` API requires Node >=22.

### Lock blocks indefinitely

Another process holds the lock. Check for stuck credhelper-daemon processes:
```bash
ps aux | grep credhelper
```
If a process crashed without releasing the lock, its fd would have been closed by the OS — this error indicates a live process is holding the lock.
