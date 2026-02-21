# Implementation Plan: Reliable `agent:in-progress` Label Cleanup

**Branch**: `207-description-when-orchestrator` | **Date**: 2026-02-21

## Summary

This plan addresses three gaps in the orchestrator's label lifecycle: (1) the `agent:in-progress` label is not removed when errors occur after the phase loop completes, (2) the reaper does not clean up labels on stale workers, and (3) post-completion errors are logged at the wrong severity. The implementation adds a `finally`-block cleanup path, extends the reaper with label removal, and introduces log-level discrimination based on a `phasesCompleted` flag.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Test framework**: Vitest
- **Key packages**: `packages/orchestrator` (all changes), `@generacy-ai/workflow-engine` (provides `GitHubClient`)
- **GitHub API**: Uses `gh` CLI via `GitHubClient.removeLabels()`, which already handles "label not found" gracefully (no-throw on 404-equivalent)

## Architecture Overview

```
ClaudeCliWorker.handle()
├── try
│   ├── checkout + routing
│   ├── phase loop (PhaseLoop.executeLoop)
│   │   ├── onError() removes agent:in-progress on phase failure ✓
│   │   └── onGateHit() leaves agent:in-progress (intentional) ✓
│   └── if completed:
│       ├── labelManager.onWorkflowComplete()  ← removes agent:in-progress
│       ├── prManager.markReadyForReview()     ← can throw (already handled)
│       └── SSE workflow:completed             ← can throw
├── catch
│   └── logs at error level (PROBLEM: no severity discrimination)
└── finally
    └── abortController.abort() only (PROBLEM: no label cleanup)

WorkerDispatcher.reapStaleWorkers()
└── releases queue item (PROBLEM: no label cleanup)
```

**After this change:**

```
ClaudeCliWorker.handle()
├── try
│   ├── ... (unchanged)
│   └── if completed:
│       ├── phasesCompleted = true             ← NEW: flag set before any cleanup
│       ├── labelManager.onWorkflowComplete()
│       ├── prManager.markReadyForReview()
│       └── SSE workflow:completed
├── catch
│   └── logs at warn (if phasesCompleted) or error (otherwise)  ← CHANGED
└── finally
    ├── abortController.abort()
    └── labelManager?.ensureCleanup(phasesCompleted)  ← NEW: safe cleanup

WorkerDispatcher.reapStaleWorkers()
├── creates ad-hoc LabelManager (or GitHub client)   ← NEW
├── calls ensureCleanup()                             ← NEW
└── releases queue item
```

## Implementation Phases

### Phase 1: Add `LabelManager.ensureCleanup()` method

**File**: `packages/orchestrator/src/worker/label-manager.ts`

Add a new public method `ensureCleanup()` that:
- Removes `agent:in-progress` label
- Removes all `phase:*` labels (fetches current labels first)
- Wraps everything in try/catch — logs at `warn` level, never throws
- Uses the existing `retryWithBackoff()` internally but catches the final throw
- Accepts a `skipIfErrorHandled: boolean` parameter — when `true` and `agent:error` label is present, skip cleanup (the error path already handled it)

```typescript
async ensureCleanup(): Promise<void> {
  try {
    // Fetch current labels to find any lingering phase:* labels
    const currentLabels = await this.getCurrentPhaseLabels();
    const labelsToRemove = ['agent:in-progress', ...currentLabels];

    if (labelsToRemove.length > 0) {
      this.logger.info(
        { labels: labelsToRemove, issue: this.issueNumber },
        'Ensuring cleanup: removing agent:in-progress and phase labels',
      );
      await this.retryWithBackoff(async () => {
        await this.github.removeLabels(
          this.owner, this.repo, this.issueNumber, labelsToRemove,
        );
      });
    }
  } catch (error) {
    // Never throw from cleanup — log and move on
    this.logger.warn(
      { error: String(error), issue: this.issueNumber },
      'Failed to ensure label cleanup (non-fatal)',
    );
  }
}
```

**Idempotency**: `removeLabels()` in the `gh-cli.ts` implementation already ignores "not found" errors (line 535), so calling `ensureCleanup()` when labels are already absent is safe.

### Phase 2: Add `phasesCompleted` flag and `finally`-block cleanup to `ClaudeCliWorker`

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

Changes to `handle()`:

1. Declare `let phasesCompleted = false` and `let labelManager: LabelManager | undefined` at the top of the method (before the try block, so it's accessible in `finally`).

2. Move the `labelManager` variable declaration outside the try block scope. Currently `labelManager` is created at line 214 inside the `try` block, making it inaccessible in `finally`. Hoist the variable declaration:
   ```typescript
   let labelManager: LabelManager | undefined;
   ```
   Then assign inside the try block:
   ```typescript
   labelManager = new LabelManager(...);
   ```

3. Set `phasesCompleted = true` immediately after the phase loop returns `completed: true` (before calling `onWorkflowComplete()`):
   ```typescript
   if (loopResult.completed) {
     phasesCompleted = true;  // NEW
     await labelManager.onWorkflowComplete();
     // ...
   }
   ```

4. Update the `catch` block to use `warn` when `phasesCompleted` is true:
   ```typescript
   } catch (error) {
     if (phasesCompleted) {
       workerLogger.warn(
         { error: String(error) },
         'Post-completion step failed (all phases completed successfully)',
       );
       // Don't emit workflow:failed — the workflow DID complete
     } else {
       workerLogger.error(
         { error: String(error) },
         'Worker encountered an unhandled error',
       );
       this.sseEmitter?.({
         type: 'workflow:failed',
         workflowId,
         data: {
           command: item.command,
           error: error instanceof Error ? error.message : String(error),
         },
       });
       throw error;
     }
   }
   ```

   Key behavioral change: when `phasesCompleted === true`, the error is **not re-thrown**. The workflow completed; the failure is in non-critical post-completion work (e.g., SSE emission). This means `WorkerDispatcher.runWorker()` will call `queue.complete()` instead of `queue.release()`.

5. Add label cleanup to the `finally` block:
   ```typescript
   } finally {
     abortController.abort();

     // Ensure agent:in-progress is cleaned up on every exit path.
     // This is a no-op if onWorkflowComplete() or onError() already removed it.
     // Only attempt cleanup if labelManager was successfully created and
     // the workflow was not paused at a gate (gate hit leaves agent:in-progress intentionally).
     if (labelManager && !gateHit) {
       await labelManager.ensureCleanup();
     }
   }
   ```

   This requires hoisting a `gateHit` flag as well, set from `loopResult.gateHit` when available.

### Phase 3: Add label cleanup to the reaper

**File**: `packages/orchestrator/src/services/worker-dispatcher.ts`

The reaper needs a way to create a GitHub client for label cleanup. Since `createGitHubClient` requires a checkout directory (it shells out via `gh`), the reaper cannot directly construct one.

**Approach**: Accept an optional `labelCleanup` callback in the constructor that takes `(owner, repo, issueNumber)` and performs the cleanup. This keeps `WorkerDispatcher` decoupled from GitHub client internals.

1. Add a new type and constructor parameter:
   ```typescript
   export type LabelCleanupFn = (
     owner: string, repo: string, issueNumber: number
   ) => Promise<void>;
   ```

2. Update `WorkerDispatcher` constructor to accept optional `labelCleanup`:
   ```typescript
   constructor(
     queue: QueueManager,
     redis: Redis,
     logger: Logger,
     config: DispatchConfig,
     handler: WorkerHandler,
     private readonly labelCleanup?: LabelCleanupFn,
   ) { ... }
   ```

3. Call it in `reapStaleWorkers()`:
   ```typescript
   if (!alive) {
     this.logger.warn(
       { workerId, item: `${worker.item.owner}/${worker.item.repo}#${worker.item.issueNumber}` },
       'Reaping stale worker (heartbeat expired)',
     );

     // Clean up labels before releasing queue item
     if (this.labelCleanup) {
       try {
         await this.labelCleanup(
           worker.item.owner, worker.item.repo, worker.item.issueNumber,
         );
       } catch (error) {
         this.logger.warn(
           { err: error, workerId },
           'Failed to clean up labels during reap (non-fatal)',
         );
       }
     }

     clearInterval(worker.heartbeatInterval);
     await this.queue.release(workerId, worker.item);
     this.activeWorkers.delete(workerId);
   }
   ```

4. The caller (wherever the dispatcher is constructed) wires up the callback using a `LabelManager` or direct GitHub API calls. This wiring is outside the scope of the core changes but should be documented.

### Phase 4: Tests

#### 4a. `label-manager.test.ts` — Test `ensureCleanup()`

**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`

New tests:
- `ensureCleanup` removes `agent:in-progress` and `phase:*` labels
- `ensureCleanup` does not throw when `removeLabels` fails (logs warn)
- `ensureCleanup` is a no-op when no labels need removal (no `phase:*` labels, `agent:in-progress` absent)
- `ensureCleanup` handles API error gracefully (no throw, logs warn)

#### 4b. `claude-cli-worker.test.ts` — Test `finally`-block cleanup and log severity

**File**: `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`

New tests:
- `finally` block calls `ensureCleanup` after successful completion
- `finally` block calls `ensureCleanup` after unhandled error (not gate hit)
- `finally` block does NOT call `ensureCleanup` when workflow paused at gate
- Post-completion error (e.g., SSE emission throws) logged at `warn` level, not `error`
- Post-completion error does not emit `workflow:failed` SSE event
- Post-completion error does not re-throw (workflow is considered complete)

#### 4c. `worker-dispatcher.test.ts` — Test reaper label cleanup

**File**: `packages/orchestrator/tests/unit/services/worker-dispatcher.test.ts`

New tests:
- Reaper calls `labelCleanup` callback when heartbeat expires
- Reaper continues if `labelCleanup` throws (logs warn, still releases queue item)
- Reaper works without `labelCleanup` callback (existing behavior preserved)

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Use callback for reaper cleanup** instead of injecting `GitHubClient` | `WorkerDispatcher` shouldn't know about GitHub internals. A callback keeps it decoupled and testable. |
| **`ensureCleanup()` never throws** | Called from `finally` blocks and reaper loops — must be safe everywhere. |
| **Set `phasesCompleted` before `onWorkflowComplete()`** | If `onWorkflowComplete()` itself throws, the flag is true and `ensureCleanup()` in `finally` will retry the cleanup. |
| **Don't re-throw post-completion errors** | If all phases completed, the workflow succeeded. Throwing would cause `queue.release()` instead of `queue.complete()`, leading to unnecessary re-processing. |
| **`ensureCleanup()` also removes `phase:*` labels** | Covers edge cases where a crash occurs between `onPhaseStart()` and `onPhaseComplete()`, leaving orphaned phase labels. |
| **No `skipIfErrorHandled` parameter on `ensureCleanup()`** | The method is idempotent. Removing an already-absent label is a no-op (verified in `gh-cli.ts` line 535). Adding complexity for an optimization isn't worth it. |
| **Hoist `labelManager` variable** | Must be accessible in `finally`. Only the variable declaration moves; the construction stays where it is (inside `try`, after checkout). |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **`ensureCleanup()` adds latency to every `finally` block** | The GitHub API call is lightweight (single `gh issue edit` command). If it fails, it's caught and logged — no retry storm. |
| **Double-removal race** | `removeLabels` is idempotent in `gh-cli.ts`. No risk from concurrent calls. |
| **`labelManager` is `undefined` in `finally`** | Guarded by `if (labelManager && !gateHit)`. If the worker crashes before `labelManager` is created, the reaper is the safety net. |
| **Reaper callback wiring omitted** | The dispatcher constructor change is backward-compatible (optional parameter). The wiring in the app bootstrap is a follow-up concern documented here. |
| **Gate hit false positive in `finally`** | `gateHit` flag is only set from `loopResult.gateHit`. If the phase loop throws before returning, `gateHit` stays `false`, and cleanup runs correctly. |

## Task Checklist

1. [ ] Add `ensureCleanup()` to `LabelManager`
2. [ ] Add tests for `ensureCleanup()`
3. [ ] Hoist `labelManager` and add `phasesCompleted`/`gateHit` flags in `ClaudeCliWorker.handle()`
4. [ ] Move label cleanup to `finally` block
5. [ ] Downgrade post-completion catch log to `warn` and suppress re-throw
6. [ ] Add tests for `finally`-block cleanup and log severity
7. [ ] Add `LabelCleanupFn` type and optional constructor parameter to `WorkerDispatcher`
8. [ ] Add label cleanup call in `reapStaleWorkers()`
9. [ ] Add tests for reaper label cleanup
10. [ ] Run full test suite and verify all tests pass
