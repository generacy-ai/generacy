# Feature Specification: Job scheduler and queue system

**Branch**: `006-job-scheduler-queue-system` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement the job scheduler that manages queuing and execution of workflow steps. The scheduler provides job queuing, priority-based processing, retry logic with exponential backoff, and dead letter handling for failed jobs.

## Parent Epic

#2 - Generacy Core Package

## Requirements

### Job Scheduler

```typescript
class JobScheduler {
  // Queue management
  enqueue(job: Job): Promise<string>;
  dequeue(): Promise<Job | undefined>;

  // Job status
  getJob(id: string): Promise<Job | undefined>;
  updateJob(id: string, update: Partial<Job>): Promise<void>;

  // Processing
  process(processor: JobProcessor): void;
  pause(): void;
  resume(): void;

  // Dead letter
  getDeadLetterQueue(): Promise<Job[]>;
  retryDeadLetter(jobId: string): Promise<void>;
}
```

### Job Definition

```typescript
type JobPriority = 'high' | 'normal' | 'low';

interface Job {
  id: string;
  workflowId: string;
  stepId: string;
  type: 'agent' | 'human' | 'integration';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  priority: JobPriority;
  attempts: number;
  maxAttempts: number;
  payload: unknown;
  result?: unknown;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}
```

### Queue Backend

**Initial Release Scope**: Redis + In-memory backends only (PostgreSQL deferred).

- **Redis** (default) - BullMQ or similar for production use
- **In-memory** - For testing and development

Redis is the expected production backend as per the architecture's docker-compose setup (orchestrator + workers + redis).

### Priority Queues

Uses named priority levels that map to workflow urgency:

| Priority | Urgency Level | Use Case |
|----------|---------------|----------|
| `high` | `blocking_now` | Immediate decisions blocking workflow |
| `normal` | `blocking_soon` | Scheduled jobs, standard processing |
| `low` | `when_available` | Background tasks, non-urgent work |

### Retry Logic

```typescript
interface RetryConfig {
  maxAttempts: number;
  backoff: 'fixed' | 'exponential';
  initialDelay: number;
  maxDelay: number;
}

// Default configuration
const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  backoff: 'exponential',
  initialDelay: 1000,  // 1 second
  maxDelay: 30000      // 30 seconds
};
```

### Dead Letter Queue

A job moves to the dead letter queue (status: `'dead'`) **after exhausting all retry attempts** (when `attempts >= maxAttempts`). This provides predictable, standard behavior where "dead" means the system has genuinely given up.

### Concurrency Control

- Configurable worker count
- Per-workflow concurrency limits
- Resource-based throttling

### Monitoring

Metrics are exposed via a **simple event emitter** for custom consumption. This follows the plugin-based, extensible architecture - Prometheus/OpenTelemetry adapters can be built on top as plugins.

Events emitted:
- `job:enqueued` - Job added to queue
- `job:started` - Job processing began
- `job:completed` - Job finished successfully
- `job:failed` - Job failed (may retry)
- `job:dead` - Job moved to dead letter queue
- `metrics:snapshot` - Periodic metrics snapshot (queue depth, processing time, error rate)

Health checks available via `scheduler.healthCheck()` method.

## Acceptance Criteria

- [ ] Jobs queue and process correctly
- [ ] Priority ordering works (high before normal before low)
- [ ] Retry with exponential backoff works
- [ ] Dead letter queue captures jobs after max retries exhausted
- [ ] Metrics available via event emitter
- [ ] Redis backend works in production mode
- [ ] In-memory backend works for testing

## User Stories

### US1: Workflow Step Execution

**As a** workflow engine,
**I want** to enqueue jobs for each workflow step,
**So that** steps execute in priority order with proper retry handling.

**Acceptance Criteria**:
- [ ] Jobs are processed in priority order (high > normal > low)
- [ ] Failed jobs are retried with exponential backoff
- [ ] Jobs exceeding max attempts move to dead letter queue

### US2: Development Testing

**As a** developer,
**I want** an in-memory queue backend,
**So that** I can test queue behavior without Redis dependencies.

**Acceptance Criteria**:
- [ ] In-memory backend implements same interface as Redis backend
- [ ] Tests can run without external services

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Enqueue jobs with priority | P1 | High/normal/low levels |
| FR-002 | Process jobs in priority order | P1 | |
| FR-003 | Retry failed jobs with backoff | P1 | Exponential by default |
| FR-004 | Move to DLQ after max retries | P1 | |
| FR-005 | Emit metrics via events | P2 | Pluggable monitoring |
| FR-006 | Support Redis backend | P1 | Production use |
| FR-007 | Support in-memory backend | P1 | Testing/development |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Job throughput | 100+ jobs/sec | Load testing with in-memory backend |
| SC-002 | Retry success rate | 80%+ transient failures recovered | Integration tests |
| SC-003 | DLQ accuracy | 100% of exhausted jobs captured | Unit tests |

## Assumptions

- Redis is available in production environment (via docker-compose)
- Job payloads are serializable to JSON
- Workflow engine handles job result processing

## Out of Scope

- PostgreSQL backend (deferred to future release)
- Prometheus/OpenTelemetry adapters (can be built as plugins)
- Distributed job locking (single-node assumed initially)
- Job scheduling/cron functionality

---

*Generated by speckit*
