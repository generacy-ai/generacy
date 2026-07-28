---
"@generacy-ai/orchestrator": patch
---

Restore `RedisQueueAdapter.enqueue()` in-flight-SET invariant (#1060).

`RedisQueueAdapter.enqueue()` previously ran `ZADD pending` only — no
`SADD orchestrator:queue:in-flight-items`, no dedupe — silently corrupting
the `in-flight = pending ∪ claimed` invariant that `CLAIM_SCRIPT`,
`ENQUEUE_IF_ABSENT_SCRIPT`, `RECLAIM_ORPHAN_SCRIPT`, `release()`, and
`complete()` all rely on. Because the `process:<workflow>` label handler is
the dominant intake path, this let a concurrent monitor `enqueueIfAbsent`
pass its `SISMEMBER` guard and land a second distinct pending member,
producing two concurrent worker claims on the same issue (observed
2026-07-28 on the tetrad-development cluster: four concurrent claims across
#1053 + #1054).

Fix:

- New `ENQUEUE_SCRIPT` Lua constant (byte-identical to
  `ENQUEUE_IF_ABSENT_SCRIPT`) executes `SISMEMBER` → conditional `SADD` +
  `ZADD` atomically. Registered as `enqueueItem` via `defineCommand`.
- `QueueAdapter.enqueue` and `QueueManager.enqueue` signatures widened from
  `Promise<void>` to `Promise<boolean>` (`true` = enqueued, `false` =
  dropped as in-flight). Both `RedisQueueAdapter` and `InMemoryQueueAdapter`
  updated. Interface JSDoc documents the invariant.
- `InMemoryQueueAdapter.enqueue()` now funnels its dedupe drop through
  `emitDropLog` with the same `{ itemKey, source: 'enqueue', reason:
  'in-flight', ageMs }` shape as Redis for cross-adapter log parity.
- `LabelMonitorService.processLabelEvent()` `type === 'process'` branch
  observes the boolean; a `false` return is treated as success (the item is
  already in flight and the enqueue's intent is satisfied). The adapter
  owns the drop log.
- `WorkerDispatcher.handleLeaseExpired()` calls `queue.release()` before
  the old `queue.enqueue()` call — with the new dedupe, a naked `enqueue()`
  here would be dropped and leave the item orphan-claimed (`CLAIM_SCRIPT`
  deliberately preserves in-flight-SET membership). The redundant
  `enqueue()` and its `getQueueItems` duplicate check are removed;
  `release()`'s retry branch atomically re-pends the item at `retry`
  priority. Lease-expired items now land at `retry` instead of `resume` —
  acceptable divergence, matches how the queue treats any retry.

Composition: additive to #1054 / PR #1056's `RECLAIM_ORPHAN_SCRIPT`.
The reclaim script deliberately does not `SREM` on reclaim; its correctness
depends on the in-flight SET being populated at enqueue time — this fix
makes that reliably true. Regression covered by
`redis-queue-adapter.enqueue-invariant.test.ts`,
`in-memory-queue-adapter.enqueue-invariant.test.ts`, and
`queue-adapter-parity.test.ts` (SC-003 cross-adapter parity, SC-004
end-to-end invariant, SC-006 regression guard).
