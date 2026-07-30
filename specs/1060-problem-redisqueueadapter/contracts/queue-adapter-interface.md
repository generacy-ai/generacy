# Contract: `QueueAdapter` / `QueueManager` interface

**File**: `packages/orchestrator/src/types/monitor.ts`.

## Signature change

### `QueueAdapter.enqueue`

```ts
// BEFORE (line ~230)
enqueue(item: QueueItem): Promise<void>;

// AFTER
enqueue(item: QueueItem): Promise<boolean>;
```

### `QueueManager.enqueue`

Inherited from `QueueAdapter` via `extends`. No local override. Signature change propagates automatically.

## Semantic contract

Every implementation of `QueueAdapter.enqueue(item)` MUST satisfy:

1. **Return-value invariant**: returns `true` iff the item was newly added to the pending queue AND the itemKey is a member of the in-flight index. Returns `false` iff the itemKey was already in flight OR a transport error occurred (implementations MAY collapse the two into a single `false` — the caller does not distinguish).

2. **Post-condition on `true`**:
   - Redis adapter: `SISMEMBER orchestrator:queue:in-flight-items item.itemKey === 1`.
   - In-memory adapter: `inFlightSet.has(item.itemKey) === true`.
   - Pending index (ZSET for Redis / sorted array for in-memory) contains a member representing this item's key.

3. **Post-condition on `false` (in-flight branch)**:
   - Neither the pending index nor the in-flight index is mutated.
   - The adapter emits exactly one log line via `emitDropLog` from `drop-log-helper.ts` with fields `{ itemKey, source: 'enqueue', reason: 'in-flight', ageMs }`.

4. **Cross-verb dedupe agreement**: after `enqueue({ itemKey: k }) === true`, a subsequent `enqueueIfAbsent({ itemKey: k })` MUST return `false`. Conversely, after `enqueueIfAbsent({ itemKey: k }) === true`, a subsequent `enqueue({ itemKey: k })` MUST return `false`.

5. **End-to-end invariant**: at every step of `enqueue → claim → release-retry → reclaim-orphan → complete`, the set equality `in-flight-index == pending-keys ∪ claimed-keys` holds (SC-004).

## Caller obligations (FR-003)

**`LabelMonitorService.processLabelEvent()` `type === 'process'` branch** (`packages/orchestrator/src/services/label-monitor-service.ts:427-428`):

- MUST observe the boolean return of `enqueue()`.
- MUST NOT log on `false` — the adapter owns the drop log (FR-005, Q4 = A).
- MUST proceed with post-enqueue steps (label management, `phaseTracker.markProcessed`) on both `true` and `false` — a `false` return means the item was already in flight, and the enqueue's intent is satisfied by the existing membership.

**`WorkerDispatcher.handleLeaseExpired()`** (`packages/orchestrator/src/services/worker-dispatcher.ts:245-278`):

- MUST call `queue.release(workerId, worker.item)` before calling `queue.enqueue(...)`.
- The subsequent `queue.enqueue(...)` call MAY be removed (recommended) or MAY be left with a `// FR-003 — expected to drop; release() already re-pended` comment.
- The `queueReason: 'resume'` priority-0 intent is *carried* by the state produced by `release()`; today's `release()` re-pends at `retry` priority (not `resume`), which is an acceptable divergence (see `research.md § Decision 3` Option R1).

**Adapters** (`InMemoryQueueAdapter`, `RedisQueueAdapter`):

- MUST route dedupe drops through `emitDropLog` with matching field shape (SC-003).
- MUST NOT expose divergent side-effects for identical input sequences (SC-003).
- MUST update return type to `Promise<boolean>` (FR-006).

## Documentation obligation (FR-006)

The `QueueAdapter` interface JSDoc MUST document the invariant `after enqueue(k), k ∈ inFlightSet` inline with the `enqueue` method — moving future engineers away from re-deriving the invariant from surrounding scripts.
