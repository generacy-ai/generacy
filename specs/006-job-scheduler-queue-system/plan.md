# Implementation Plan: Job Scheduler and Queue System

**Feature**: Job scheduler for managing queuing and execution of workflow steps
**Branch**: `006-job-scheduler-queue-system`
**Status**: Complete

## Summary

Implement a job scheduler that provides priority-based job queuing, retry with exponential backoff, dead letter handling, and pluggable backends (Redis and in-memory). The scheduler integrates with the existing workflow engine to execute workflow steps in priority order.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript (ES2022 modules) |
| Runtime | Node.js 20+ |
| Dependencies | ioredis (existing), uuid |
| Testing | Vitest |
| Patterns | Event emitter for metrics, backend abstraction via interface |

## Project Structure

```text
src/
├── scheduler/
│   ├── index.ts                    # Public exports
│   ├── types.ts                    # Job, JobScheduler, and related types
│   ├── job-scheduler.ts            # Main JobScheduler class
│   ├── job-processor.ts            # Worker that processes jobs
│   ├── backends/
│   │   ├── index.ts                # Backend exports
│   │   ├── backend.interface.ts    # QueueBackend interface
│   │   ├── redis-backend.ts        # Redis implementation (BullMQ-style)
│   │   └── memory-backend.ts       # In-memory implementation
│   └── events.ts                   # Event types and emitter utilities
tests/
├── scheduler/
│   ├── job-scheduler.test.ts       # Core scheduler tests
│   ├── job-processor.test.ts       # Processor tests
│   ├── backends/
│   │   ├── redis-backend.test.ts   # Redis backend tests (integration)
│   │   └── memory-backend.test.ts  # Memory backend tests (unit)
│   └── retry.test.ts               # Retry/backoff tests
```

## Implementation Phases

### Phase 1: Core Types and Interfaces

**Files**: `src/scheduler/types.ts`, `src/scheduler/backends/backend.interface.ts`

Define:
- `Job` interface with id, workflowId, stepId, type, status, priority, attempts, payload
- `JobPriority` enum: high, normal, low
- `JobStatus` enum: pending, processing, completed, failed, dead
- `RetryConfig` interface (reuse from `src/types/config.ts`)
- `QueueBackend` interface with enqueue, dequeue, get, update, acknowledge, nack methods
- `JobProcessor` type for job handling functions

### Phase 2: In-Memory Backend

**Files**: `src/scheduler/backends/memory-backend.ts`, `tests/scheduler/backends/memory-backend.test.ts`

Implement:
- Priority queue using sorted arrays
- Job storage with Map
- FIFO within same priority level
- Atomic dequeue with visibility timeout
- Dead letter tracking

### Phase 3: Redis Backend

**Files**: `src/scheduler/backends/redis-backend.ts`, `tests/scheduler/backends/redis-backend.test.ts`

Implement:
- Use Redis sorted sets for priority queues (score = timestamp + priority offset)
- Job data in hash keys
- Atomic dequeue with WATCH/MULTI or Lua scripts
- Visibility timeout via separate sorted set
- Dead letter queue as separate sorted set

### Phase 4: Job Scheduler Core

**Files**: `src/scheduler/job-scheduler.ts`, `src/scheduler/job-processor.ts`

Implement:
- `JobScheduler` class coordinating backend operations
- `enqueue()` - add job with priority
- `dequeue()` - fetch highest priority job
- `getJob()`, `updateJob()` - job state management
- `pause()`, `resume()` - processing control
- Dead letter queue operations
- Event emission for metrics

### Phase 5: Event System and Metrics

**Files**: `src/scheduler/events.ts`

Implement:
- `SchedulerEvents` interface with event types
- Events: job:enqueued, job:started, job:completed, job:failed, job:dead
- Periodic metrics:snapshot event with queue depth, processing time, error rate
- `healthCheck()` method

### Phase 6: Integration and Testing

**Files**: All test files, update `src/index.ts`

- Unit tests for all components
- Integration tests with Redis
- Export public API from main index

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| Backend abstraction | Allows swapping Redis/in-memory without code changes |
| Named priority levels | Aligns with workflow urgency semantics (blocking_now, blocking_soon, when_available) |
| Event emitter for metrics | Extensible - Prometheus/OTEL adapters can be built as plugins |
| Reuse existing RetryConfig | Consistent with codebase patterns in `src/types/config.ts` |
| Dead letter after max retries | Standard, predictable behavior; immediate DL for specific errors can be added later |

## Dependencies

| Package | Purpose | Status |
|---------|---------|--------|
| ioredis | Redis client | Existing |
| uuid | Job ID generation | Existing or add |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Redis connection failures | Graceful degradation, connection retry, health checks |
| Job processing deadlocks | Visibility timeout auto-releases stuck jobs |
| Memory leaks in in-memory backend | Size limits, job cleanup on completion |

## Integration Points

- **Workflow Engine**: Calls `scheduler.enqueue()` for workflow steps
- **Message Router**: May use scheduler for message delivery jobs
- **Monitoring**: Subscribes to scheduler events for metrics collection

## Next Steps

Run `/speckit:tasks` to generate detailed task list from this plan.
