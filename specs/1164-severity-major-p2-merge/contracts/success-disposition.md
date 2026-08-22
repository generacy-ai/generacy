# Contract: `applySuccessDisposition` label set + `afterEnqueue` ordering

**FRs**: FR-006, FR-007, FR-008
**Sites**: `merge-conflict-handler.ts:691-714` (label set),
`worker-result.ts:25` (`PostCompleteAction.afterEnqueue`),
`claude-cli-worker.ts:414-450` (closure build),
`worker-dispatcher.ts:460-509` (invocation)

---

## FR-007 — label invalidation on re-arm

`applySuccessDisposition` removes, in one `github.removeLabels(owner, repo, issueNumber, …)`
batch:

```
[COMPLETED_MERGE_CONFLICTS_LABEL,     // unchanged
 WAITING_FOR_MERGE_CONFLICTS_LABEL,   // unchanged
 'completed:validate',                // ADDED (FR-007)
 'completed:implementation-review']   // ADDED (FR-007)
```

It **no longer** clears `AGENT_IN_PROGRESS_LABEL` / `AGENT_PAUSED_LABEL` — those move to
`afterEnqueue` (FR-008).

**Effect**: the #1133 terminal short-circuit (`phase-loop.ts:353-374`), which fires only
when both `completed:validate` and `completed:implementation-review` are present, no longer
fires on the post-merge tree. `validate` runs on the merged tree before mark-ready.

**Idempotency**: removing an absent label is a no-op; the batch is safe when either label
was never granted.

---

## FR-008 — `afterEnqueue` ordering

### Type
```ts
type PostCompleteAction = {
  readonly kind: 'rearm';
  readonly rearmItem: QueueItem;
  readonly afterEnqueue?: () => Promise<void>;
};
```

### Worker builds the closure (`claude-cli-worker.ts`)
```ts
const afterEnqueue = async () => {
  await github.removeLabels(owner, repo, issueNumber, [
    AGENT_IN_PROGRESS_LABEL,
    AGENT_PAUSED_LABEL,
  ]);
};
return { status: 'completed', postComplete: { kind: 'rearm', rearmItem, afterEnqueue } };
```

### Dispatcher invokes after enqueue (`worker-dispatcher.ts`)
```
await this.queue.complete(workerId, item);
if (result.postComplete?.kind === 'rearm') {
  try {
    const enqueued = await this.queue.enqueueIfAbsent(result.postComplete.rearmItem);
    // ... existing enqueued / !enqueued logging ...
    try {
      await result.postComplete.afterEnqueue?.();   // FR-008: runs on enqueued AND dropped
    } catch (err) {
      // best-effort: log at warn, do not fail the dispatch
    }
  } catch (err) {
    // enqueue threw — pause + ownership labels intact for next poll; afterEnqueue NOT run
  }
}
```

### Ordering guarantees
- `afterEnqueue` runs **only after** `enqueueIfAbsent` resolves.
- Runs on `enqueued === true` and on the dropped (`enqueued === false`) case.
- Does **not** run if `enqueueIfAbsent` threw (outer catch) — ownership labels must survive
  so the next poll can recover.
- Best-effort: an `afterEnqueue` rejection is caught and logged; the dispatch still
  succeeds.

### Crash-window analysis
| Crash point | State left | Recovery |
|-------------|-----------|----------|
| after `complete`, before `enqueueIfAbsent` | pause + ownership labels intact | next poll re-enqueues |
| after `enqueueIfAbsent`, before `afterEnqueue` | queued work + stale `agent:*` label | `onResumeStart` overwrites the stale label; in-flight SET prevents double-claim |
| after `afterEnqueue` | queued work, ownership cleared | normal |

The reorder converts the pre-#1164 failure mode ("no label + no work" → silent stall) into
"queued work + benign stale label".

## Test assertions
- SC-004: with `ciMergeGateEnabled=true`, `reviewPhaseEnabled=false`, a post-resolution
  re-arm runs `validate` on the merged tree before mark-ready (short-circuit suppressed by
  FR-007 label removal).
- SC-005: simulated crash between enqueue and `afterEnqueue` leaves a queued item + a
  stale ownership label — recoverable, not stranded.
- Dispatcher order test: `afterEnqueue` is invoked strictly after `enqueueIfAbsent`, and
  not at all when `enqueueIfAbsent` throws.
