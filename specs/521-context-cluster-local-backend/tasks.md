# Tasks: fd-based advisory lock for cluster-local backend

**Input**: Design documents from `/specs/521-context-cluster-local-backend/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Replace `withLock()` in `packages/credhelper-daemon/src/backends/file-store.ts`
  - Remove `private lockPromise: Promise<void> = Promise.resolve();` property (line 20)
  - Add `private readonly lockPath: string;` property
  - Set `this.lockPath = \`${dataPath}.lock\`;` in constructor
  - Replace `withLock()` method (lines 103-113) with fd-based implementation:
    ```ts
    private async withLock<T>(fn: () => Promise<T>): Promise<T> {
      const fh = await fs.open(this.lockPath, 'w');
      try {
        await fh.lock(true);
        return await fn();
      } finally {
        await fh.close();
      }
    }
    ```

## Phase 2: Tests

- [X] T002 [US1] Update advisory lock tests in `packages/credhelper-daemon/__tests__/backends/file-store.test.ts`
  - Add test: lock file is created at `${dataPath}.lock` after first `save()`
  - Add test: concurrent `save()` calls (parallel `Promise.all`) produce no data corruption — final file is valid JSON with correct entries
  - Existing tests (ensureMasterKey, load, save, sequential advisory lock) should pass unchanged

## Phase 3: Verification

- [X] T003 [US2] Verify zero dependency changes
  - Run `vitest run` in `packages/credhelper-daemon` — all tests pass
  - Confirm `package.json` has no diff (no new dependencies added)

## Dependencies & Execution Order

- T001 must complete before T002 (tests depend on new implementation)
- T003 runs after T002 (verification of the complete change)
- No parallel opportunities — this is a linear 3-task sequence on a single file pair
