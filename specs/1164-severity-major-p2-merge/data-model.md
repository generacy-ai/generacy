# Data Model: Merge-conflict scoped-review lifecycle fixes

**Branch**: `1164-severity-major-p2-merge`

No new persisted state and no new label vocabulary. Two existing internal types gain an
optional field; one existing label-removal set grows. All types are internal to
`@generacy-ai/orchestrator` (`worker/`) — none cross the package public boundary.

---

## 1. `ReviewScope` (extended) — `worker/handler-outcome.ts`

**Before**:
```ts
export interface ReviewScope {
  readonly baseSha: string;
  readonly headSha: string;
}
```

**After**:
```ts
export interface ReviewScope {
  readonly baseSha: string;
  readonly headSha: string;
  /**
   * FR-003 — conflicted file paths captured at resolution time
   * (`git diff --name-only --diff-filter=U`). When present, the scoped review is
   * restricted to this allowlist instead of the raw `baseSha..headSha` parent-1 diff,
   * excluding changes that came only from the merged-in base branch. Absent on
   * non-merge-conflict scopes and on no-op / clean-merge success paths.
   */
  readonly conflictedPaths?: readonly string[];
}
```

**Transport (unchanged path, new field rides along)**:
`getResolutionScope` → `ReArmedOutcome.reviewScope` → `rearmItem.metadata.reviewScope`
(`claude-cli-worker.ts:425-432`) → `WorkerContext.reviewScope` → `review-executor.ts:97`
→ charter `diffWindow` (`review-charter.ts:27`).

**Validation rules**:
- `conflictedPaths` MAY be empty or absent → charter falls back to the `baseSha..headSha`
  range description (pre-#1164 behavior). It is populated only on the
  post-conflict-resolution success path (`merge-conflict-handler.ts:389`).
- Paths are repository-relative, as emitted by `git diff --name-only`.

---

## 2. `PostCompleteAction` rearm variant (extended) — `worker/worker-result.ts`

**Before**:
```ts
export type PostCompleteAction = {
  readonly kind: 'rearm';
  readonly rearmItem: QueueItem;
};
```

**After**:
```ts
export type PostCompleteAction = {
  readonly kind: 'rearm';
  readonly rearmItem: QueueItem;
  /**
   * FR-008 — invoked by the dispatcher AFTER `enqueueIfAbsent` resolves (on enqueued
   * and dropped, NOT on throw). Clears the ownership (`agent:*`) labels. Built by the
   * worker (which holds the `GitHubClient`); the dispatcher has none in worker mode.
   * Best-effort: a failure must not fail the dispatch.
   */
  readonly afterEnqueue?: () => Promise<void>;
};
```

**Why a closure, not data**: the dispatcher cannot construct a `GitHubClient` in worker
mode (`labelCleanup` is `undefined`, `server.ts:462-470`), and `postComplete` is passed
in-process (never serialized to Redis), so a function field is safe and is the minimal
seam.

---

## 3. Label-set delta — `applySuccessDisposition` (`merge-conflict-handler.ts:691-714`)

**Removed from the batch (moved to `afterEnqueue`, FR-008)**:
- `AGENT_IN_PROGRESS_LABEL` (`agent:in-progress`)
- `AGENT_PAUSED_LABEL` (`agent:paused`)

**Added to the batch (FR-007)**:
- `completed:validate`
- `completed:implementation-review`

**Unchanged in the batch**:
- `COMPLETED_MERGE_CONFLICTS_LABEL`
- `WAITING_FOR_MERGE_CONFLICTS_LABEL`

**Net batch after change** (non-ownership + FR-007 invalidation):
```
[COMPLETED_MERGE_CONFLICTS_LABEL,
 WAITING_FOR_MERGE_CONFLICTS_LABEL,
 'completed:validate',
 'completed:implementation-review']
```
Ownership labels (`agent:in-progress`, `agent:paused`) are cleared separately by the
`afterEnqueue` closure post-enqueue.

**Note on constants**: `completed:validate` / `completed:implementation-review` are used
here as literal strings (define file-local `const`s next to the existing label imports;
no new shared vocabulary is introduced — these labels already exist in the protocol).

---

## 4. Round-gating state (FR-001) — no new type, a read-order change

The gate is the existing engine review artifact read via `readReviewArtifact`:

| Round | `priorRound` | `reviewScope` honored? | Review window |
|-------|--------------|------------------------|---------------|
| 1 | `null` | yes (if present) | scoped: conflicted-path allowlist |
| 2+ | non-null | **no** (cleared) | #1126 delta `lastReviewedCommitSha`..HEAD |

The state that distinguishes the rounds already exists (`priorRound.round`,
`priorRound.lastReviewedCommitSha`); the fix only moves the `priorRound` read ahead of the
`reviewScope` branch so `!priorRound` can gate scope usage.

---

## Relationships

```
MergeConflictHandler.handle()
  └─ conflictedPaths (live local, :275-291)
       └─ pushAndSucceed(..., conflictedPaths)         [FR-003 thread]
            └─ finishSuccess(..., conflictedPaths)
                 ├─ applySuccessDisposition()          [FR-007 labels; FR-008 no longer clears agent:*]
                 └─ getResolutionScope(..., conflictedPaths) → ReviewScope{ …, conflictedPaths }

ClaudeCliWorker (rearm block, :414-450)
  ├─ rearmItem.metadata.reviewScope = outcome.reviewScope    [carries conflictedPaths]
  └─ postComplete = { kind:'rearm', rearmItem, afterEnqueue } [FR-008 closure built here]

WorkerDispatcher (success path, :460-509)
  ├─ queue.complete()
  ├─ enqueueIfAbsent(rearmItem)
  └─ afterEnqueue?.()                                        [FR-008 post-enqueue clear]

ReviewExecutor (:80-199)
  ├─ priorRound = readReviewArtifact()                       [FR-001 read first]
  ├─ honor reviewScope only when !priorRound
  └─ charter diffWindow = reviewScope (round 1 only)

ReviewCharter (:143-154)
  └─ trivial-diff paragraph iff !verification && !diffWindow  [FR-004]

PhaseLoop (#1133 short-circuit, :353-374)
  └─ fires on completed:validate + completed:implementation-review
       (both now cleared by FR-007 → does not fire on post-merge tree)
```
