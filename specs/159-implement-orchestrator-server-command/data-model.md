# Data Model: Orchestrator Server

## Core Entities

### Job

```typescript
interface Job {
  id: string;
  name: string;
  status: JobStatus;
  priority: number;             // Higher = more urgent (default: 0)

  // Workflow definition
  workflow: string | object;    // YAML string, path, or parsed object
  inputs: Record<string, unknown>;

  // Execution context
  workdir?: string;
  timeout?: number;             // Job timeout in ms
  retries?: number;             // Remaining retry attempts

  // Timestamps
  createdAt: string;            // ISO 8601
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;

  // Assignment
  assignedWorker?: string;

  // Metadata
  tags?: string[];              // Capability matching
  metadata?: Record<string, unknown>;
}

type JobStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';
```

### JobResult

```typescript
interface JobResult {
  jobId: string;
  status: 'completed' | 'failed' | 'cancelled';

  // Success case
  outputs?: Record<string, unknown>;

  // Failure case
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };

  // Execution metadata
  duration?: number;            // Execution time in ms
  metrics?: {
    stepsExecuted: number;
    stepsSucceeded: number;
    stepsFailed: number;
  };
}
```

### Worker

```typescript
interface RegisteredWorker {
  id: string;
  name: string;
  capabilities: string[];       // Tags this worker can handle
  maxConcurrent: number;        // Max simultaneous jobs

  // Runtime state
  currentJobs: string[];        // Currently assigned job IDs
  status: WorkerStatus;

  // Health tracking
  lastHeartbeat: Date;
  registeredAt: Date;

  // Optional info
  healthEndpoint?: string;      // URL for direct health checks
  metadata?: Record<string, unknown>;
}

type WorkerStatus = 'healthy' | 'unhealthy' | 'offline';
```

### WorkerRegistration (Request)

```typescript
interface WorkerRegistration {
  id?: string;                  // Client-provided or server-generated
  name: string;
  capabilities?: string[];      // Default: ['*'] (all jobs)
  maxConcurrent?: number;       // Default: 1
  healthEndpoint?: string;
  metadata?: Record<string, unknown>;
}
```

### Heartbeat

```typescript
interface Heartbeat {
  workerId: string;
  status: 'idle' | 'busy' | 'stopping';
  currentJob?: {
    id: string;
    progress?: number;          // 0-100
    currentStep?: string;
  };
  metrics?: {
    memoryUsage: number;        // Bytes
    uptime: number;             // Seconds
  };
}

interface HeartbeatResponse {
  acknowledged: boolean;
  command?: HeartbeatCommand;
  config?: {
    pollInterval?: number;
    heartbeatInterval?: number;
  };
}

type HeartbeatCommand = 'cancel' | 'shutdown' | 'config-update';
```

### PollResponse

```typescript
interface PollResponse {
  job: Job | null;
  retryAfter?: number;          // Seconds until next poll (when no job)
}
```

## State Transitions

### Job State Machine

```
                  ┌─────────┐
                  │ pending │
                  └────┬────┘
                       │ assign to worker
                       ▼
                  ┌─────────┐
          ┌───────│assigned │───────┐
          │       └────┬────┘       │
          │            │ worker     │ timeout/
          │            │ starts     │ worker lost
          │            ▼            │
          │       ┌─────────┐       │
          │       │ running │───────┤
          │       └────┬────┘       │
          │            │            │
     ┌────┴────┐  ┌────┴────┐  ┌────┴────┐
     │cancelled│  │completed│  │ failed  │
     └─────────┘  └─────────┘  └─────────┘
```

### Worker State Machine

```
    register
        │
        ▼
   ┌─────────┐
   │ healthy │◄──────┐
   └────┬────┘       │
        │ heartbeat  │ heartbeat
        │ missed     │ received
        ▼            │
   ┌─────────┐───────┘
   │unhealthy│
   └────┬────┘
        │ timeout exceeded
        ▼
   ┌─────────┐
   │ offline │───► removed from registry
   └─────────┘
```

## Storage Schema

### In-Memory Storage

```typescript
// Job storage
const jobs = new Map<string, Job>();
const pendingJobs: Job[] = [];              // Sorted by priority

// Worker storage
const workers = new Map<string, RegisteredWorker>();

// Index: worker -> assigned jobs
const workerJobs = new Map<string, Set<string>>();
```

### Redis Storage (Optional)

```
# Job data
HSET job:{id} data <JSON>

# Pending queue (sorted by priority)
ZADD jobs:pending {priority} {jobId}

# Assigned jobs per worker
SADD worker:{id}:jobs {jobId}

# Worker data
HSET worker:{id} data <JSON>

# Worker heartbeat tracking
ZADD workers:heartbeat {timestamp} {workerId}

# Active worker set
SADD workers:active {workerId}
```

## Validation Rules

### Job Creation

| Field | Rule |
|-------|------|
| name | Required, non-empty string |
| workflow | Required, string or object |
| priority | Optional, default 0, integer |
| timeout | Optional, positive integer |
| retries | Optional, non-negative integer |
| tags | Optional, array of strings |

### Worker Registration

| Field | Rule |
|-------|------|
| name | Required, non-empty string |
| id | Optional, auto-generated if not provided |
| capabilities | Optional, default ['*'] |
| maxConcurrent | Optional, default 1, positive integer |

### Heartbeat

| Field | Rule |
|-------|------|
| workerId | Required, must match registered worker |
| status | Required, one of: idle, busy, stopping |
| currentJob | Optional, required if status is busy |

## Relationships

```
┌──────────────┐        ┌──────────────┐
│    Worker    │ 1    n │     Job      │
│              │────────│              │
│ id           │        │ assignedWorker│
│ currentJobs[]│◄───────│ id           │
└──────────────┘        └──────────────┘
                               │
                               │ produces
                               ▼
                        ┌──────────────┐
                        │  JobResult   │
                        │              │
                        │ jobId        │
                        │ status       │
                        │ outputs      │
                        └──────────────┘
```

## Error Types

```typescript
interface OrchestratorError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Error codes
const ErrorCodes = {
  // Client errors (4xx)
  INVALID_REQUEST: 'INVALID_REQUEST',
  WORKER_NOT_FOUND: 'WORKER_NOT_FOUND',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  UNAUTHORIZED: 'UNAUTHORIZED',
  WORKER_ALREADY_EXISTS: 'WORKER_ALREADY_EXISTS',

  // Server errors (5xx)
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  QUEUE_ERROR: 'QUEUE_ERROR',
} as const;
```
