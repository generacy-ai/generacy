# Implementation Plan: Fix atomicWrite EXDEV in worker-scaler

**Feature**: Fix cross-device rename error in `atomicWrite()` — `packages/control-plane/src/services/worker-scaler.ts`
**Branch**: `701-problem-packages-control-plane`
**Status**: Complete

## Summary

`atomicWrite()` creates temp files in `os.tmpdir()` (`/tmp`, container overlay) then calls `rename()` to targets on a Docker named volume (`/workspaces/`). Since these are different filesystems, `rename(2)` fails with `EXDEV`. The fix is to place the temp file in `dirname(targetPath)` so the rename stays on the same filesystem.

Single-file, 2-line change + test improvement.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js >=22
- **Package**: `packages/control-plane`
- **Test framework**: Vitest
- **Dependencies affected**: None (uses only `node:fs/promises`, `node:path`, `node:crypto`)

## Project Structure

```
packages/control-plane/
  src/services/
    worker-scaler.ts          # FIX: atomicWrite() at line 176-180
  __tests__/services/
    worker-scaler.test.ts     # UPDATE: add same-filesystem assertion
```

## Changes

### 1. Fix `atomicWrite()` temp file location

**File**: `packages/control-plane/src/services/worker-scaler.ts`

- Import `dirname` from `node:path` (already imports `join`)
- Change `tmpPath` from `join(tmpdir(), ...)` to `join(dirname(targetPath), ...)`
- Use dot-prefixed name (`.{hex}.tmp`) to avoid polluting the target directory
- Remove unused `tmpdir` import from `node:os`

Before:
```ts
const tmpPath = join(tmpdir(), `generacy-${randomBytes(8).toString('hex')}.tmp`);
```

After:
```ts
const tmpPath = join(dirname(targetPath), `.${randomBytes(8).toString('hex')}.tmp`);
```

### 2. Improve test coverage

**File**: `packages/control-plane/__tests__/services/worker-scaler.test.ts`

- Add a test or assertion that verifies the temp file is created in the same directory as the target (not in `os.tmpdir()`)
- Add a comment documenting why this constraint matters (EXDEV prevention)

## Risk Assessment

- **Blast radius**: Minimal — single private function, 2 callers within the same file
- **Regression risk**: Low — existing tests continue to pass; behavior change only affects temp file location
- **Rollback**: Trivial revert

## Verification

1. `pnpm test` in `packages/control-plane` — all existing tests pass
2. New test validates temp file placement in `dirname(targetPath)`
