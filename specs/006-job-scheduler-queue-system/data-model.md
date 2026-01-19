# Data Model: Job Scheduler and Queue System

## Core Entities

### Job

The primary entity representing a unit of work in the queue.

```typescript
type JobPriority = 'high' | 'normal' | 'low';
type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
type JobType = 'agent' | 'human' | 'integration';

interface Job {
  /** Unique job identifier (format: job_<uuid>) */
  id: string;

  /** Associated workflow ID */
  workflowId: string;

  /** Workflow step this job executes */
  stepId: string;

  /** Type of job - determines handler */
  type: JobType;

  /** Current job status */
  status: JobStatus;

  /** Priority level for queue ordering */
  priority: JobPriority;

  /** Number of execution attempts */
  attempts: number;

  /** Maximum attempts before dead letter */
  maxAttempts: number;

  /** Job-specific input data */
  payload: unknown;

  /** Result from successful execution */
  result?: unknown;

  /** Error message from failed execution */
  error?: string;

  /** Job creation timestamp (ISO 8601) */
  createdAt: string;

  /** Processing start timestamp */
  startedAt?: string;

  /** Completion timestamp (success or final failure) */
  completedAt?: string;

  /** Visibility timeout for processing (ms) */
  visibilityTimeout?: number;

  /** Timestamp when visibility timeout expires */
  visibleAt?: number;
}
```

### JobCreateInput

Input for creating a new job.

```typescript
interface JobCreateInput {
  workflowId: string;
  stepId: string;
  type: JobType;
  priority?: JobPriority;  // Default: 'normal'
  payload: unknown;
  maxAttempts?: number;    // Default: 3
  visibilityTimeout?: number;  // Default: 30000
}
```

### RetryConfig

Configuration for retry behavior (reuses existing type).

```typescript
interface RetryConfig {
  /** Maximum number of retry attempts */
  maxAttempts: number;

  /** Initial delay in milliseconds */
  initialDelay: number;

  /** Maximum delay in milliseconds */
  maxDelay: number;

  /** Backoff multiplier */
  backoffFactor: number;
}

const DEFAULT_JOB_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
};
```

### SchedulerConfig

Configuration for the job scheduler.

```typescript
interface SchedulerConfig {
  /** Queue backend to use */
  backend: 'redis' | 'memory';

  /** Redis configuration (required for redis backend) */
  redis?: RedisConfig;

  /** Retry configuration */
  retry?: Partial<RetryConfig>;

  /** Concurrency settings */
  concurrency?: ConcurrencyConfig;

  /** Metrics emission interval (ms), 0 to disable */
  metricsIntervalMs?: number;

  /** Visibility timeout default (ms) */
  defaultVisibilityTimeout?: number;
}
```

### ConcurrencyConfig

Configuration for worker concurrency limits.

```typescript
interface ConcurrencyConfig {
  /** Maximum concurrent jobs globally */
  maxGlobalWorkers: number;

  /** Maximum concurrent jobs per workflow (optional) */
  maxPerWorkflow?: number;

  /** Maximum concurrent jobs per job type (optional) */
  maxPerJobType?: Partial<Record<JobType, number>>;
}
```

## Event Types

### SchedulerEvents

Events emitted by the scheduler for monitoring.

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

### SchedulerMetrics

Metrics snapshot structure.

```typescript
interface SchedulerMetrics {
  /** Snapshot timestamp */
  timestamp: number;

  /** Queue depth by priority */
  queueDepth: {
    high: number;
    normal: number;
    low: number;
    total: number;
  };

  /** Currently processing jobs */
  processing: number;

  /** Jobs in dead letter queue */
  deadLetter: number;

  /** Jobs completed in last minute */
  completedLastMinute: number;

  /** Jobs failed in last minute */
  failedLastMinute: number;

  /** Average processing time (ms) */
  avgProcessingTimeMs: number;
}
```

## Backend Interface

### QueueBackend

Interface that all queue backends must implement.

```typescript
interface QueueBackend {
  // Core queue operations
  enqueue(job: Job): Promise<void>;
  dequeue(priority?: JobPriority): Promise<Job | undefined>;
  acknowledge(jobId: string): Promise<void>;
  nack(jobId: string, error: string): Promise<void>;

  // Job management
  getJob(id: string): Promise<Job | undefined>;
  updateJob(id: string, update: Partial<Job>): Promise<void>;

  // Queue info
  getQueueDepth(priority?: JobPriority): Promise<number>;
  getProcessingCount(): Promise<number>;

  // Dead letter operations
  getDeadLetterJobs(): Promise<Job[]>;
  retryDeadLetter(jobId: string): Promise<void>;

  // Visibility timeout
  refreshVisibility(jobId: string, timeoutMs: number): Promise<void>;
  releaseTimedOutJobs(): Promise<number>;

  // Lifecycle
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthCheckResult>;
}

interface HealthCheckResult {
  healthy: boolean;
  details?: {
    connected: boolean;
    queueDepth: number;
    lastError?: string;
  };
}
```

## Redis Key Schema

Keys used by the Redis backend.

```typescript
const SCHEDULER_KEYS = {
  // Job data storage
  JOB: 'scheduler:job:',                    // Hash: job:<id>

  // Priority queues (sorted sets)
  QUEUE_HIGH: 'scheduler:queue:high',       // ZSET: score=timestamp
  QUEUE_NORMAL: 'scheduler:queue:normal',
  QUEUE_LOW: 'scheduler:queue:low',

  // Processing set (visibility timeout)
  PROCESSING: 'scheduler:processing',       // ZSET: score=visibleAt

  // Dead letter queue
  DLQ: 'scheduler:dlq',                     // ZSET: score=deadAt

  // Concurrency tracking
  ACTIVE_WORKFLOWS: 'scheduler:active:workflows',  // Hash: workflowId -> count
  ACTIVE_TYPES: 'scheduler:active:types',          // Hash: type -> count

  // Metrics
  METRICS_COMPLETED: 'scheduler:metrics:completed',  // List: timestamps
  METRICS_FAILED: 'scheduler:metrics:failed',        // List: timestamps
  METRICS_PROCESSING_TIME: 'scheduler:metrics:time', // List: durations
} as const;
```

## Validation Rules

### Job Validation

```typescript
const JOB_VALIDATION = {
  id: {
    pattern: /^job_[0-9a-f-]{36}$/,
    required: true,
  },
  workflowId: {
    minLength: 1,
    maxLength: 255,
    required: true,
  },
  stepId: {
    minLength: 1,
    maxLength: 255,
    required: true,
  },
  type: {
    enum: ['agent', 'human', 'integration'],
    required: true,
  },
  priority: {
    enum: ['high', 'normal', 'low'],
    default: 'normal',
  },
  maxAttempts: {
    min: 1,
    max: 10,
    default: 3,
  },
  visibilityTimeout: {
    min: 5000,
    max: 300000,
    default: 30000,
  },
};
```

## Entity Relationships

```text
Workflow (external)
    │
    └── 1:N ──> Job
                  │
                  ├── status transitions:
                  │   pending -> processing -> completed
                  │              │
                  │              └-> failed -> [retry] -> processing
                  │                    │
                  │                    └-> [max retries] -> dead
                  │
                  └── stored in:
                      ├── Queue (by priority)
                      ├── Processing set (during execution)
                      └── Dead letter queue (after exhaustion)
```

## State Transitions

### Job Status State Machine

```text
                  ┌─────────────────────────┐
                  │                         │
                  ▼                         │
┌─────────┐   dequeue   ┌────────────┐   retry (attempts < max)
│ pending │ ──────────> │ processing │ ─────────┐
└─────────┘             └────────────┘          │
                              │                 │
              ┌───────────────┼───────────────┐ │
              │               │               │ │
              ▼               ▼               ▼ │
        ┌───────────┐  ┌────────┐      ┌────────┤
        │ completed │  │ failed │ <────┘        │
        └───────────┘  └────────┘               │
                              │                 │
                              │ attempts >= max │
                              ▼                 │
                        ┌──────┐                │
                        │ dead │                │
                        └──────┘                │
                              │                 │
                              │ manual retry    │
                              └─────────────────┘
```
