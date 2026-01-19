# Research: Job Scheduler and Queue System

## Technology Decisions

### Queue Backend Selection

**Decision**: Use ioredis with custom implementation rather than BullMQ

**Rationale**:
- BullMQ adds ~500KB to bundle and has complex feature set we don't need
- ioredis already in codebase (`src/persistence/redis-store.ts`)
- Custom implementation gives full control over priority semantics
- Easier to align with existing patterns (event emitter, retry config)

**Alternatives Considered**:
- **BullMQ**: Feature-rich but heavy, learning curve for contributors
- **Bee-Queue**: Simpler than BullMQ but less maintained
- **Custom on ioredis**: Chosen - lightweight, full control, consistent patterns

### Priority Queue Implementation

**Redis Approach**: Sorted sets with composite scores

```typescript
// Score calculation: priority offset + timestamp
// Lower score = higher priority = dequeued first
const priorityOffsets = {
  high: 0,
  normal: 1_000_000_000_000,  // 1 trillion
  low: 2_000_000_000_000,      // 2 trillion
};

function calculateScore(priority: JobPriority): number {
  return priorityOffsets[priority] + Date.now();
}
```

This ensures:
- High priority jobs always process before normal/low
- Within same priority, FIFO ordering by timestamp
- Atomic operations via `ZADD` and `ZPOPMIN`

**In-Memory Approach**: Three separate arrays (high, normal, low) with FIFO pop

### Retry Strategy

**Decision**: Reuse existing `RetryConfig` from `src/types/config.ts`

The codebase already has:
- `RetryConfig` interface with maxAttempts, initialDelay, maxDelay, backoffFactor
- `calculateRetryDelay()` function with jitter in `src/utils/retry.ts`
- `DEFAULT_RETRY_CONFIG` constant

**Spec defaults differ slightly**:
- Spec: maxAttempts=3, initialDelay=1000, maxDelay=30000
- Existing: maxAttempts=5, initialDelay=1000, maxDelay=16000

**Resolution**: Create `DEFAULT_JOB_RETRY_CONFIG` specific to jobs while keeping existing config for other uses.

### Event System Design

**Pattern**: Typed event emitter (matches `MessageQueue` and `DeadLetterQueue` patterns)

```typescript
interface SchedulerEvents {
  'job:enqueued': (job: Job) => void;
  'job:started': (job: Job) => void;
  'job:completed': (job: Job, result: unknown) => void;
  'job:failed': (job: Job, error: Error) => void;
  'job:dead': (job: Job) => void;
  'metrics:snapshot': (metrics: SchedulerMetrics) => void;
}
```

**Metrics Snapshot Structure**:
```typescript
interface SchedulerMetrics {
  timestamp: number;
  queueDepth: {
    high: number;
    normal: number;
    low: number;
    total: number;
  };
  processing: number;
  deadLetter: number;
  completedLastMinute: number;
  failedLastMinute: number;
  avgProcessingTimeMs: number;
}
```

### Visibility Timeout

**Purpose**: Prevent job loss if processor crashes mid-processing

**Implementation**:
- On dequeue, job moves to "processing" set with timeout score
- If not acknowledged within timeout, job returns to queue
- Background task checks for timed-out jobs every 30 seconds

**Default Timeout**: 30 seconds (configurable per job type)

### Dead Letter Handling

**Criteria**: Job moves to DLQ when `attempts >= maxAttempts`

**DLQ Operations**:
- `getDeadLetterQueue()` - list all dead jobs
- `retryDeadLetter(jobId)` - move job back to main queue, reset attempts

**Storage**:
- Redis: Separate sorted set `scheduler:dlq` with jobs sorted by death time
- In-memory: Separate array

## Implementation Patterns

### Backend Interface

```typescript
interface QueueBackend {
  // Core operations
  enqueue(job: Job): Promise<void>;
  dequeue(priority?: JobPriority): Promise<Job | undefined>;
  acknowledge(jobId: string): Promise<void>;
  nack(jobId: string, error: string): Promise<void>;

  // Job management
  getJob(id: string): Promise<Job | undefined>;
  updateJob(id: string, update: Partial<Job>): Promise<void>;

  // Queue info
  getQueueDepth(priority?: JobPriority): Promise<number>;

  // Dead letter
  getDeadLetterJobs(): Promise<Job[]>;
  retryDeadLetter(jobId: string): Promise<void>;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

### Job ID Generation

**Decision**: Use `crypto.randomUUID()` (Node.js native, no dependency)

Format: `job_<uuid>` (e.g., `job_550e8400-e29b-41d4-a716-446655440000`)

### Concurrency Control

**Per-workflow limits**:
```typescript
interface ConcurrencyConfig {
  maxGlobalWorkers: number;        // Total concurrent jobs
  maxPerWorkflow?: number;         // Per-workflow limit
  maxPerJobType?: Record<JobType, number>;  // Per-type limit
}
```

**Implementation**:
- Track active jobs by workflowId in Redis hash
- Check limits before dequeue
- Decrement on acknowledge/nack

## References

- [Redis Sorted Sets](https://redis.io/docs/data-types/sorted-sets/)
- [BullMQ Architecture](https://docs.bullmq.io/guide/architecture) (for patterns, not direct use)
- Existing codebase:
  - `src/persistence/message-queue.ts` - Event emitter pattern
  - `src/persistence/dead-letter-queue.ts` - DLQ handling
  - `src/utils/retry.ts` - Backoff calculation
