# Data Model: In-Flight-Keyed Resume Dedupe (#862)

## Redis Keyspace

### New key

| Key                                     | Type | Members                                    | Owner                                                                                                                     |
|-----------------------------------------|------|--------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `orchestrator:queue:in-flight-items`    | SET  | `itemKey` strings: `<owner>/<repo>#<issue>` | `RedisQueueAdapter` (writes inside the new `ENQUEUE_IF_ABSENT_SCRIPT` and inside `MULTI/EXEC` in `release`/`complete`). |

**Cardinality**: bounded by concurrent open workflow issues (typical: dozens; ceiling: hundreds).
**Persistence**: same Redis instance / DB as the rest of `orchestrator:queue:*`. No TTL — membership is authoritatively maintained by state transitions. If Redis is flushed (loss of pending + claimed too), the SET flushes with it; consistency is preserved.
**Invariant**: `itemKey ∈ in-flight-items` ⇔ `itemKey ∈ pending OR ∃workerId. itemKey ∈ claimed:<workerId>`.

### Existing keys — modified access patterns

| Key                                          | Change                                                                                                              |
|----------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| `orchestrator:queue:pending`                 | Writes inside `ENQUEUE_IF_ABSENT_SCRIPT` (co-atomic with SET add). Unchanged for retry re-queue path.               |
| `orchestrator:queue:claimed:<workerId>`      | No structural change. `CLAIM_SCRIPT` unchanged — the item is already in SET when claim occurs.                     |
| `orchestrator:queue:dead-letter`             | Dead-lettering now co-atomically removes from SET (see `release`/`complete` MULTI/EXEC changes).                     |
| `phase-tracker:<owner>:<repo>:<issue>:resume:<gate>` | No longer written or read. Existing keys from #849 era age out under 24 h TTL — no migration step needed.       |
| `phase-tracker:<owner>:<repo>:<issue>:<workflow-name>` (process-branch keys) | Unchanged. `PhaseTracker.clear`/`isDuplicate`/`markProcessed` remain for `type === 'process'`.  |

## Type-Level Contracts (TypeScript)

### `QueueManager` extension (`packages/orchestrator/src/types/monitor.ts`)

```ts
export interface QueueManager extends QueueAdapter {
  claim(workerId: string): Promise<QueueItem | null>;
  release(workerId: string, item: QueueItem): Promise<void>;
  complete(workerId: string, item: QueueItem): Promise<void>;
  getQueueDepth(): Promise<number>;
  getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]>;
  getActiveWorkerCount(): Promise<number>;

  /**
   * Atomically enqueue an item iff its `itemKey` is not already in flight
   * (pending or claimed by any worker).
   *
   * Semantics (per clarifications Q1 → B, Q2 → A, Q3 → A, Q4 → A):
   *   - itemKey = `<owner>/<repo>#<issue>`
   *   - "In flight" = membership in `orchestrator:queue:in-flight-items`, which
   *     tracks the union of pending + claimed. Orphaned claims count as in-flight
   *     until the dispatcher's reclaim path fires.
   *   - Race-free: two concurrent calls with the same itemKey → one returns true,
   *     the other returns false. No double-enqueue.
   *   - Redis-error safe: returns false + logs warn on transport failure. Caller's
   *     poll cycle re-fires the event.
   *
   * @returns true if the item was enqueued, false if it was already in flight or
   *          a transport error occurred.
   */
  enqueueIfAbsent(item: QueueItem): Promise<boolean>;

  /**
   * Observability helper — SISMEMBER against the in-flight SET.
   * NOT used on the dedupe path (Q1: enqueueIfAbsent is the atomic gate).
   * Exposed for admin/queue routes and future cockpit views.
   */
  hasInFlight(itemKey: string): Promise<boolean>;
}
```

`QueueAdapter` (narrow interface used by `LabelMonitorService`) does **not** grow. The service is upgraded to consume `QueueManager`. `server.ts` already passes the `QueueManager` instance into the monitor's constructor (line 372) — no wiring change beyond widening the parameter type in `LabelMonitorService.constructor`.

### `LabelManager` shrinks

```ts
// Delete:
export type ClearResumeDedupeCallback = (gate: string) => Promise<void>;

// LabelManager constructor: 5 params instead of 6
export class LabelManager {
  constructor(
    private readonly github: GitHubClient,
    private readonly owner: string,
    private readonly repo: string,
    private readonly issueNumber: number,
    private readonly logger: Logger,
    // private readonly clearResumeDedupe?: ClearResumeDedupeCallback,  <-- DELETED
  ) {}

  async onGateHit(phase: WorkflowPhase, gateLabel: string): Promise<void> {
    // ... existing retryWithBackoff around removeLabels + addLabels ...
    // DELETED: try { await this.clearResumeDedupe?.(gateSuffix); } catch (err) { this.logger.warn(...) }
  }
}
```

### `ClaudeCliWorkerDeps` shrinks

```ts
export interface ClaudeCliWorkerDeps {
  jobEventEmitter?: JobEventEmitter;
  tokenProvider?: () => Promise<string | undefined>;
  // phaseTracker?: PhaseTracker;  <-- DELETED (was #849 wiring)
}
```

At the `new LabelManager(...)` site inside `phase-loop.ts` / `claude-cli-worker.ts` (~line 406–422), delete the closure arg and the trailing paired-clear call.

### `SerializedQueueItem` — unchanged

The Lua script serializes exactly what `RedisQueueAdapter.enqueue` serializes today: full `SerializedQueueItem` JSON, with `priority`, `attemptCount: 0`, `itemKey`. The script is invoked from TypeScript with those fields already computed by the caller — no schema drift.

## Validation Rules

1. **`itemKey` derivation** must be identical everywhere. Existing `buildItemKey(item)` at `redis-queue-adapter.ts:44` and `in-memory-queue-adapter.ts:14` are already the same; the new `hasInFlight(itemKey)` takes the string directly (caller derives). No accidental double-derivation drift.
2. **SET invariants** — the following must hold at every quiescent moment:
   - Every member of `orchestrator:queue:in-flight-items` corresponds to an item in either `pending` (ZSCORE non-nil) or exactly one `claimed:<workerId>` hash (HEXISTS `itemKey` == 1).
   - Every pending ZSET member's decoded `itemKey` is in the SET.
   - Every claimed HASH field name is in the SET.
   - Dead-lettered items are NOT in the SET (their transition SREMs on the way out).
3. **Fail-safe direction**: on Redis transport error, `enqueueIfAbsent` returns `false` (drop, will retry on next poll). Never returns `true` on error.
4. **No side effects on false-return**: if `enqueueIfAbsent` returns `false`, the caller (`LabelMonitorService`) must NOT modify labels, MUST emit the info log line, MUST return early. In particular, `phaseTracker.markProcessed` is NOT called for the resume branch (deleted entirely).

## Relationships

```
LabelMonitorService.processLabelEvent(event: LabelEvent)
  │
  ├── if event.type === 'process':
  │     ├── phaseTracker.clear + isDuplicate + markProcessed   (UNCHANGED)
  │     └── queueAdapter.enqueue(item)                          (UNCHANGED)
  │
  └── if event.type === 'resume':
        └── queueManager.enqueueIfAbsent(item)                  (NEW — sole dedupe gate)
              │
              ├─ Redis Lua atomic:
              │    SISMEMBER in-flight-items itemKey
              │    → if 0: SADD + ZADD pending, return 1
              │    → if 1: return 0
              │
              └─ returns Promise<boolean>
                  ├─ true  → log "Issue enqueued (resume)"
                  └─ false → log "Dropping resume event (item already in flight)" + return early

WorkerDispatcher.claim(workerId) → uses existing CLAIM_SCRIPT (SET membership preserved).

WorkerDispatcher.complete(workerId, item) → MULTI: HDEL claimed + SREM in-flight.
WorkerDispatcher.release(workerId, item)  → HDEL claimed;
  ├─ if attemptCount < maxRetries: ZADD pending (SET unchanged — still in flight)
  └─ if attemptCount ≥ maxRetries: MULTI: ZADD dead-letter + SREM in-flight (drop from SET).
```
