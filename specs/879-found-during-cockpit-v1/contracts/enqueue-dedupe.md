# Contract: PR-feedback enqueue dedupe (#879)

Describes the pre/post state and observable behavior of the `PrFeedbackMonitorService.processPrReviewEvent` enqueue decision, before and after the migration. This is the internal contract that FR-001…FR-011 collectively pin down and that SC-001…SC-005 verify.

## Preconditions

For all cases below, assume:

- `link = prLinker.linkPrToIssue(...)` succeeded → we have `owner`, `repo`, `issueNumber`, `prNumber`.
- Assignee check passed (issue is assigned to this cluster's identity).
- `client.getPRReviewThreads(owner, repo, prNumber)` succeeded — auth is healthy.
- Trust classification (`isTrustedCommentAuthor`) has been applied → we have `unresolvedThreadIds` (the trusted subset) and `untrustedCommentSkips`.

## Case Matrix

### Case C: no unresolved threads (`totalUnresolvedThreads === 0`)

**Enqueue?** No. Return `false`. State-transition log emitted per #861. Both `lastUnresolvedThreadCount` and `lastZeroTrustedState` reset.

**Contract**: unchanged from current behavior.

---

### Case B: unresolved threads exist, but zero are trust-live (`unresolvedThreadIds.length === 0 && totalUnresolvedThreads > 0`)

**Enqueue?** No — this is the #869 interaction guard. Return `false`. Warn log emitted (per #874 shape). `maybePostUntrustedNotice` fires on the transition edge (idempotent by grep against `UNTRUSTED_NOTICE_MARKER`).

**Contract**: **must** remain unchanged. **SC-005** is the regression fence: if this branch ever starts enqueuing, self-clearing dedupe busy-loops.

---

### Case A: at least one thread is trust-live (`unresolvedThreadIds.length > 0`)

This is where the migration lives.

**Before (current code, `pr-feedback-monitor-service.ts:334-390`):**

```
1. logger.info("Found N unresolved review thread(s)")
2. lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length)
3. isNew = await phaseTracker.tryMarkProcessed(owner, repo, issueNumber, 'address-pr-feedback')
4. if !isNew:
     logger.info("Skipping duplicate — PR feedback already enqueued for this issue")
     return false
5. workflowName = await resolveWorkflowName(...)
6. build queueItem { command: 'address-pr-feedback', queueReason: 'resume', ... }
7. await queueAdapter.enqueue(queueItem)
8. logger.info("PR feedback work enqueued")
9. try { await client.addLabels(..., ['waiting-for:address-pr-feedback']) }
   catch { logger.warn("Failed to add waiting-for label") }
10. return true
```

**After (post-migration):**

```
1. logger.info("Found N unresolved review thread(s)")
2. lastUnresolvedThreadCount.set(stateKey, unresolvedThreadIds.length)
3. try { await client.addLabels(..., ['waiting-for:address-pr-feedback']) }        [FR-010: idempotent, before enqueue]
   catch { logger.warn("Failed to add waiting-for label") }
4. workflowName = await resolveWorkflowName(...)
5. build queueItem { command: 'address-pr-feedback', queueReason: 'resume', ... }
6. enqueued = await queueManager.enqueueIfAbsent(queueItem)                        [FR-001]
7. if !enqueued:
     logger.info({ itemKey, reason: 'in-flight', prNumber, issueNumber },          [FR-009]
                 "Dropping PR-feedback enqueue (item already in flight)")
     return false
8. logger.info("PR feedback work enqueued")
9. return true
```

**Key changes:**

- **Step 3 moves before enqueue** — label is added whenever Case A holds, decoupled from enqueue outcome. Guarantees FR-010.
- **Step 3 (old) and step 4 (old) deleted** — no more `phaseTracker.tryMarkProcessed` call and no more "Skipping duplicate" log line. Replaced by `enqueueIfAbsent` return value.
- **Step 7 (new) log** matches the label-monitor resume-branch shape at `label-monitor-service.ts:336-346`. `itemKey` is `${owner}/${repo}#${issueNumber}`.

## Adapter-Level Contract

Both `RedisQueueAdapter.enqueueIfAbsent` (`services/redis-queue-adapter.ts:113-147`) and `InMemoryQueueAdapter.enqueueIfAbsent` (`services/in-memory-queue-adapter.ts:82-105`) must, on the `false`-return path, emit:

```typescript
logger.info(
  { itemKey, reason: 'in-flight' },
  'Dropping enqueue (item already in flight)',
);
```

Where `itemKey = buildItemKey(item) = ${item.owner}/${item.repo}#${item.issueNumber}`.

Return semantics unchanged: `true` on successful enqueue, `false` on in-flight collision. Errors continue to propagate as thrown exceptions (Redis path) — those are distinct from the non-error `false` return and stay `warn`.

## Handler-Side Contract

`PrFeedbackHandler` is now purely a consumer of the queue with **no dedupe interaction**. Post-migration:

- No `DEDUP_PHASE` constant.
- No `phaseTracker` field or ctor param.
- No `clearDedupe()` calls on any of the five terminal exit paths (former `:259`, `:289`, `:370`, `:376`, `:383`).

All other handler behavior (branch switch, CLI spawn, commit+push, thread replies, label removal on success) is preserved unchanged.

**Self-clearing property**: When the handler completes (any terminal path — success, timeout, exception, drop), the `QueueManager.complete()` or `.release()` call in the worker loop removes the itemKey from the in-flight set. The next poll with a trusted state re-enqueues on `enqueueIfAbsent → true`. This satisfies FR-006 without any per-surface clearing bookkeeping.

## Invariants

| # | Invariant | Enforced by |
|---|-----------|-------------|
| I1 | For any issue, at most one queue item is in-flight at any time (single-writer-per-issue). | `enqueueIfAbsent` Lua script + `buildItemKey` (no `command` component). Q2→A. |
| I2 | Zero-trusted PRs never enqueue on any poll. | Case B branch returning early. SC-005. |
| I3 | Trusted unresolved feedback with no in-flight item enqueues on the first poll, regardless of Redis history. | `enqueueIfAbsent` gates on live in-flight set only. SC-001. |
| I4 | `waiting-for:address-pr-feedback` label is present on the issue whenever Case A holds, regardless of enqueue outcome. | Label add moved before enqueue call. FR-010. |
| I5 | An in-flight collision emits a structured `info` log with `itemKey` and `reason: 'in-flight'`. | Adapter-level FR-009 log. |
| I6 | No `phase-tracker:*:address-pr-feedback` write remains anywhere under `packages/orchestrator/src/**`. | Audit test (SC-004). |

## Failure Modes

| Scenario | Behavior |
|----------|----------|
| Redis unavailable during `enqueueIfAbsent` | Existing `warn` log path in `redis-queue-adapter.ts:140-146` is preserved (fail-safe drop). Distinct from the FR-009 `info` line, which fires on non-error `false` returns. |
| `client.addLabels` fails | Non-fatal `warn` (unchanged). Enqueue continues. Label will retry on next poll (idempotent). |
| Handler crashes mid-work | Worker loop's `claim`/`release` machinery returns the item to the in-flight cleanup path. `enqueueIfAbsent` will succeed on next poll — no TTL wait. Contrast with pre-migration: crash between `tryMarkProcessed` and settlement stranded the key for ~24h. |
| Simultaneous webhook + poll | Both call `enqueueIfAbsent(queueItem)` with the same `itemKey`. Lua script (Redis) or `Set.has` check (memory) makes exactly one succeed; the other logs the in-flight drop line. Queue depth == 1. SC-002. |
