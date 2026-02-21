# Tasks: Reliable `agent:in-progress` Label Cleanup

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: LabelManager — Add `ensureCleanup()` Method

### T001 [US1] Add `ensureCleanup()` method to `LabelManager`
**File**: `packages/orchestrator/src/worker/label-manager.ts`
- Add public async method `ensureCleanup(): Promise<void>` after `onWorkflowComplete()` (after line 133)
- Call `getCurrentPhaseLabels()` to discover lingering `phase:*` labels
- Build removal list: `['agent:in-progress', ...phaseLabels]`
- If list is non-empty, call `retryWithBackoff()` to remove all labels via `github.removeLabels()`
- Wrap the entire method body in try/catch — log failures at `warn` level, never throw
- Log at `info` level before attempting removal (include issue number and label list)

### T002 [US1] Verify `onWorkflowComplete()` idempotency on 404
**File**: `packages/orchestrator/src/worker/label-manager.ts`
- Confirm that `github.removeLabels()` (via `gh-cli.ts`) handles "label not found" gracefully
- No code change expected — document the verified behavior in a code comment on `ensureCleanup()`
- If 404 handling is missing, add a try/catch around `removeLabels` in `onWorkflowComplete()`

---

## Phase 2: ClaudeCliWorker — `finally`-Block Cleanup and Log Severity

### T003 [US1] Hoist `labelManager` variable declaration out of `try` block
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Declare `let labelManager: LabelManager | undefined` before the `try` block (around line 137, after `abortController`)
- Change the existing `const labelManager = new LabelManager(...)` at line 214 to an assignment: `labelManager = new LabelManager(...)`
- Verify TypeScript compilation succeeds — the variable is now accessible in `finally`

### T004 [US1] Add `phasesCompleted` and `gateHit` flags
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Declare `let phasesCompleted = false` before the `try` block (next to `labelManager`)
- Declare `let gateHit = false` before the `try` block
- Set `phasesCompleted = true` immediately after `if (loopResult.completed)` at line 264, before calling `onWorkflowComplete()`
- Set `gateHit = true` inside the `else if (loopResult.gateHit)` branch at line 279

### T005 [US1] Move label cleanup to `finally` block
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- In the `finally` block (line 317), after `abortController.abort()`, add:
  ```typescript
  if (labelManager && !gateHit) {
    await labelManager.ensureCleanup();
  }
  ```
- This is a no-op if `onWorkflowComplete()` or `onError()` already removed labels (ensureCleanup is idempotent)
- Gate hits intentionally leave `agent:in-progress` — the guard prevents unwanted cleanup

### T006 [US3] Downgrade post-completion error log severity and suppress re-throw
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Modify the `catch` block (lines 301-316) to discriminate based on `phasesCompleted`:
  - If `phasesCompleted === true`: log at `warn` level with message `'Post-completion step failed (all phases completed successfully)'`, do NOT emit `workflow:failed` SSE, do NOT re-throw
  - If `phasesCompleted === false`: keep existing behavior (log at `error`, emit SSE, re-throw)
- The `phasesCompleted` path not re-throwing means `WorkerDispatcher.runWorker()` calls `queue.complete()` instead of `queue.release()`

---

## Phase 3: WorkerDispatcher — Reaper Label Cleanup

### T007 [US2] Add `LabelCleanupFn` type and optional constructor parameter
**File**: `packages/orchestrator/src/services/worker-dispatcher.ts`
- Export a new type: `export type LabelCleanupFn = (owner: string, repo: string, issueNumber: number) => Promise<void>`
- Add optional `labelCleanup?: LabelCleanupFn` as the last constructor parameter
- Store as `private readonly labelCleanup?: LabelCleanupFn`
- Existing callers are unaffected (parameter is optional)

### T008 [US2] Add label cleanup call in `reapStaleWorkers()`
**File**: `packages/orchestrator/src/services/worker-dispatcher.ts`
- In `reapStaleWorkers()` (line 242), inside the `if (!alive)` block, before `queue.release()`:
  - Call `this.labelCleanup?.(worker.item.owner, worker.item.repo, worker.item.issueNumber)`
  - Wrap in try/catch — log failures at `warn` level, continue with queue release
- The reaper must not crash if label cleanup fails — it should always proceed to release the queue item

---

## Phase 4: Tests

### T009 [P] [US1] Write tests for `ensureCleanup()` in `LabelManager`
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
- Add new `describe('ensureCleanup')` block with the following tests:
  - `removes agent:in-progress and phase:* labels` — mock `getIssue` to return labels including `phase:specify` and `agent:in-progress`, verify `removeLabels` called with both
  - `does not throw when removeLabels fails` — mock `removeLabels` to throw, verify method resolves without error, verify `warn` logged
  - `is a no-op when no relevant labels exist` — mock `getIssue` to return empty labels, verify `removeLabels` not called
  - `handles getIssue failure gracefully` — mock `getIssue` to throw, verify method resolves without error, verify `warn` logged
  - `retries on transient failure` — mock `removeLabels` to fail once then succeed, verify retry behavior

### T010 [P] [US1, US3] Write tests for `finally`-block cleanup and log severity in `ClaudeCliWorker`
**File**: `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`
- Add new `describe('finally-block cleanup')` block with the following tests:
  - `calls ensureCleanup after successful completion` — verify `ensureCleanup` called after all phases complete
  - `calls ensureCleanup after unhandled error` — mock phase loop to throw, verify `ensureCleanup` still called
  - `does not call ensureCleanup when workflow paused at gate` — mock gate hit, verify `ensureCleanup` not called
  - `logs at warn level when post-completion step fails` — mock `markReadyForReview` to throw after phases complete, verify `warn` not `error`
  - `does not emit workflow:failed when post-completion step fails` — same scenario, verify SSE emitter not called with `workflow:failed`
  - `does not re-throw when post-completion step fails` — same scenario, verify `handle()` resolves (does not reject)

### T011 [P] [US2] Write tests for reaper label cleanup in `WorkerDispatcher`
**File**: `packages/orchestrator/tests/unit/services/worker-dispatcher.test.ts`
- Add new `describe('reaper label cleanup')` block with the following tests:
  - `calls labelCleanup when heartbeat expires` — provide `labelCleanup` fn to constructor, simulate expired heartbeat, verify callback called with correct owner/repo/issueNumber
  - `continues reaping if labelCleanup throws` — mock callback to throw, verify queue.release still called and worker removed from activeWorkers
  - `works without labelCleanup callback (backward-compatible)` — construct without callback, simulate expired heartbeat, verify existing behavior (release + delete) unchanged

---

## Phase 5: Validation

### T012 Run full test suite and verify all tests pass
**Files**:
- `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
- `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`
- `packages/orchestrator/tests/unit/services/worker-dispatcher.test.ts`
- Run `pnpm --filter orchestrator test` to execute all orchestrator tests
- Verify 0 failures across existing and new tests
- Verify TypeScript compilation with `pnpm --filter orchestrator build` (or `tsc --noEmit`)

### T013 Manual review of label cleanup idempotency
**Files**:
- `packages/orchestrator/src/worker/label-manager.ts`
- Review all paths that remove `agent:in-progress`: `onWorkflowComplete()`, `onError()`, `ensureCleanup()`
- Confirm no double-removal errors or unexpected side effects
- Verify `ensureCleanup()` in `finally` is harmless when labels already removed by earlier code

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (ClaudeCliWorker depends on `ensureCleanup()` method)
- Phase 1 must complete before Phase 3 (reaper cleanup callback may use `ensureCleanup()` pattern)
- Phase 2 and Phase 3 can run in parallel after Phase 1
- Phase 4 (testing) can begin in parallel once the implementation phase for each component completes
- Phase 5 runs after all other phases

**Parallel opportunities within phases**:
- T001 and T002 are sequential (T002 verifies behavior used by T001)
- T003, T004 are sequential (T004 depends on hoisted variable from T003)
- T005 depends on T003 and T004
- T006 depends on T004
- T007 and T008 are sequential (T008 uses the type from T007)
- T009, T010, T011 can all run in parallel (different test files, independent)

**Critical path**:
T001 → T002 → T003 → T004 → T005 → T006 → T010 → T012

**Secondary path (can parallel with T003–T006)**:
T007 → T008 → T011

**Independent test path**:
T009 (can start after T001)
