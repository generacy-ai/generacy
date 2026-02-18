# Data Model: Redis Queue with Worker Claim and Dispatch

## Core Entities

### QueueItem (existing — unchanged)

Represents an issue enqueued for workflow processing. Defined in `types/monitor.ts`.

```typescript
interface QueueItem {
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** Issue number */
  issueNumber: number;
  /** Workflow name parsed from label (e.g., "speckit-feature") */
  workflowName: string;
  /** Command type: "process" for new, "continue" for resume */
  command: 'process' | 'continue';
  /** Priority score (timestamp for FIFO, lower = higher priority) */
  priority: number;
  /** When this item was enqueued */
  enqueuedAt: string;
}
```

### QueueManager (new — extends QueueAdapter)

Broad interface for queue operations used by the dispatcher and routes.

```typescript
interface QueueManager extends QueueAdapter {
  /** Atomically claim the highest-priority item for a worker */
  claim(workerId: string): Promise<QueueItem | null>;

  /** Release a claimed item back to the pending queue */
  release(workerId: string, item: QueueItem): Promise<void>;

  /** Mark a claimed item as complete and remove it */
  complete(workerId: string, item: QueueItem): Promise<void>;

  /** Get the number of items in the pending queue */
  getQueueDepth(): Promise<number>;

  /** Get paginated list of pending items with scores */
  getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]>;

  /** Get the number of currently active (claimed) workers */
  getActiveWorkerCount(): Promise<number>;
}
```

### QueueItemWithScore

Queue item with its priority score, used for listing.

```typescript
interface QueueItemWithScore {
  item: QueueItem;
  score: number;
}
```

### SerializedQueueItem

Internal representation stored in Redis, adding retry tracking.

```typescript
interface SerializedQueueItem extends QueueItem {
  /** Number of times this item has been claimed and released */
  attemptCount: number;
  /** Unique key for deduplication in the sorted set */
  itemKey: string;
}
```

### WorkerInfo

Represents an active worker tracked by the dispatcher.

```typescript
interface WorkerInfo {
  /** Unique worker ID */
  workerId: string;
  /** The item being processed */
  item: QueueItem;
  /** When the worker started processing */
  startedAt: number;
  /** Heartbeat refresh interval handle */
  heartbeatInterval: NodeJS.Timeout;
  /** Promise resolving when the handler completes */
  promise: Promise<void>;
}
```

### WorkerHandler

Callback signature for processing queue items.

```typescript
type WorkerHandler = (item: QueueItem) => Promise<void>;
```

## Redis Key Patterns

### Pending Queue (Sorted Set)

```
Key:    orchestrator:queue:pending
Type:   Sorted Set
Member: JSON-serialized SerializedQueueItem
Score:  priority value (lower = higher priority, typically Date.now())
```

### Claimed Items (Hash per Worker)

```
Key:    orchestrator:queue:claimed:{workerId}
Type:   Hash
Field:  itemKey (e.g., "{owner}/{repo}#{issueNumber}")
Value:  JSON-serialized SerializedQueueItem
```

### Worker Heartbeat (String with TTL)

```
Key:    orchestrator:worker:{workerId}:heartbeat
Type:   String
Value:  "1" (presence-only)
TTL:    WORKER_HEARTBEAT_TTL_MS / 1000 seconds (default: 30)
```

### Dead-Letter Queue (Sorted Set)

```
Key:    orchestrator:queue:dead-letter
Type:   Sorted Set
Member: JSON-serialized SerializedQueueItem (attemptCount >= maxRetries)
Score:  timestamp when dead-lettered
```

## Configuration Schema Extensions

```typescript
const DispatchConfigSchema = z.object({
  /** Interval between queue polls in milliseconds */
  pollIntervalMs: z.number().int().min(1000).default(5000),
  /** Maximum number of concurrent workers */
  maxConcurrentWorkers: z.number().int().min(1).max(20).default(3),
  /** Worker heartbeat TTL in milliseconds */
  heartbeatTtlMs: z.number().int().min(5000).default(30000),
  /** Interval between heartbeat/reaper checks in milliseconds */
  heartbeatCheckIntervalMs: z.number().int().min(5000).default(15000),
  /** Timeout for graceful shutdown of workers in milliseconds */
  shutdownTimeoutMs: z.number().int().min(5000).default(60000),
  /** Maximum retry attempts before dead-lettering */
  maxRetries: z.number().int().min(1).default(3),
});
```

## Validation Rules

- `workerId` must be a non-empty string (generated as UUID by the dispatcher)
- `priority` must be a non-negative number (typically `Date.now()` for FIFO)
- `attemptCount` must be a non-negative integer, starts at 0
- `itemKey` format: `{owner}/{repo}#{issueNumber}` — uniquely identifies an issue in the queue
- `offset` and `limit` for `getQueueItems` must be non-negative integers
- `heartbeatTtlMs` must be greater than `heartbeatCheckIntervalMs` to avoid premature reaping

## Relationships

```
LabelMonitorService ──enqueue()──→ QueueAdapter (subset)
                                        ▲
                                        │ extends
                                        │
WorkerDispatcher ──claim/release/──→ QueueManager (full)
                   complete
                                        ▲
                                        │ implements
                                        │
                                  RedisQueueAdapter
                                        │
                                        ▼
                               Redis (sorted sets, hashes, strings)
```

---

*Generated by speckit*
