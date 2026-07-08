# Contract: `QueueManager.enqueueIfAbsent` and `hasInFlight`

Applies to both `RedisQueueAdapter` and `InMemoryQueueAdapter`. Both implementations must satisfy these contracts.

## `enqueueIfAbsent(item: QueueItem): Promise<boolean>`

### Preconditions

- `item.owner`, `item.repo`, `item.issueNumber` are non-empty / positive.
- Caller has already resolved `item.workflowName`, `item.command`, `item.queueReason`, `item.enqueuedAt`, `item.metadata`.
- `itemKey` is derived internally as `` `${item.owner}/${item.repo}#${item.issueNumber}` `` (same rule as `enqueue`).

### Behavior

1. Derive `itemKey` from `item`.
2. Derive `priority` via `getPriorityScore(item.queueReason)`.
3. Construct `SerializedQueueItem` with `attemptCount: 0`, `itemKey`, `priority` set.
4. **Atomically**:
   - If `itemKey` is a member of the in-flight index (Redis SET, or in-memory `Set<string>`), return `false` without side effects on `pending`/`claimed`/SET.
   - Otherwise, add `itemKey` to the in-flight index and add the serialized item to the pending queue with `priority`. Return `true`.

Atomicity is w.r.t. concurrent callers on the same `itemKey`: two concurrent `enqueueIfAbsent` calls with the same `itemKey` produce exactly one `true` return and one `false` return, and the pending queue contains exactly one member for that `itemKey`.

### Postconditions

- Returned `true` → `itemKey ∈ in-flight-items` AND pending contains exactly one member for this `itemKey` (with the new priority score).
- Returned `false` → in-flight and pending are unchanged (no phantom writes on the fail path).

### Error handling

- **Redis transport error** in `RedisQueueAdapter`: log `warn` with `{ err, itemKey }`, return `false`. **Do not throw**. Do not partially write.
- **`InMemoryQueueAdapter`**: no transport errors possible. Implementation is synchronous under the hood but returns `Promise<boolean>` for interface parity.

### Log lines

- On `true` return: existing `enqueue`-side log (`"Item enqueued to Redis sorted set"` / in-memory equivalent) is emitted by the underlying primitive. Caller (`LabelMonitorService`) additionally emits an `info` line at its layer (existing `"Issue enqueued"` log).
- On `false` return: the underlying primitive emits no log. Caller emits the structured info line:
  ```
  info { itemKey, gate, reason: 'in-flight', source: 'webhook' | 'poll' } 'Dropping resume event (item already in flight)'
  ```

## `hasInFlight(itemKey: string): Promise<boolean>`

### Behavior

- `RedisQueueAdapter`: `SISMEMBER orchestrator:queue:in-flight-items itemKey` → boolean.
- `InMemoryQueueAdapter`: `this.inFlightSet.has(itemKey)` → boolean.
- **Not** on any dedupe path. Exposed for admin routes / cockpit / operator debugging.

### Error handling

- Redis error → log `warn`, return `false` (best-effort observability, do not throw).

## Contract table — SET maintenance invariants across all `QueueManager` methods

| Method                                | Pending change                            | Claimed change                     | In-flight SET change                           |
|---------------------------------------|-------------------------------------------|------------------------------------|------------------------------------------------|
| `enqueue(item)`                       | ZADD pending (unconditional)              | —                                  | **SADD (idempotent for retries).**             |
| `enqueueIfAbsent(item)`               | ZADD pending iff not in-flight            | —                                  | SADD iff not in-flight (co-atomic in Lua).     |
| `claim(workerId)`                     | ZPOPMIN pending                           | HSET claimed:<workerId>            | no change (itemKey stays in SET).              |
| `release(workerId, item)` (retry)     | ZADD pending (retry priority)             | HDEL claimed:<workerId>            | no change (itemKey stays in SET).              |
| `release(workerId, item)` (deadletter)| ZADD dead-letter                          | HDEL claimed:<workerId>            | **SREM (co-atomic in MULTI/EXEC).**             |
| `complete(workerId, item)`            | —                                          | HDEL claimed:<workerId>            | **SREM (co-atomic in MULTI/EXEC).**             |

Note the `enqueue(item)` row: `enqueue` remains itemKey-blind (idempotent SADD is safe — SETs are idempotent by nature). It exists for the retry-requeue path inside `release`, where the SET member is already present. Callers that need the "reject if in-flight" gate MUST call `enqueueIfAbsent` instead.

## Fail-safe rationale

The chosen error-direction (drop on failure) matches the spec's core property: a dropped resume is deferred, not lost — labels persist on the issue, next poll re-fires. A false-`true` return would allow the double-enqueue race we are closing. Fail-safe = fail-drop.
