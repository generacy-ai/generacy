# Tasks: Job Scheduler and Queue System

**Input**: Design documents from `/specs/006-job-scheduler-queue-system/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Types and Interfaces

- [X] T001 [US1] Create `src/scheduler/types.ts` with Job, JobPriority, JobStatus, JobType, JobCreateInput, RetryConfig, SchedulerConfig, ConcurrencyConfig
- [X] T002 [P] [US1] Create `src/scheduler/backends/backend.interface.ts` with QueueBackend interface and HealthCheckResult
- [X] T003 [P] [US1] Create `src/scheduler/events.ts` with SchedulerEvents interface, SchedulerMetrics type, and event constants

## Phase 2: In-Memory Backend (Testing Foundation)

- [X] T004 [US2] Create `tests/scheduler/backends/memory-backend.test.ts` with test cases for all QueueBackend operations
- [X] T005 [US2] Create `src/scheduler/backends/memory-backend.ts` implementing QueueBackend with priority arrays
- [X] T006 [US2] Implement priority ordering in memory backend (high > normal > low, FIFO within priority)
- [X] T007 [US2] Implement visibility timeout handling in memory backend (visibleAt tracking, auto-release)
- [X] T008 [US2] Implement dead letter queue operations in memory backend (getDeadLetterJobs, retryDeadLetter)

## Phase 3: Redis Backend

- [X] T009 [US1] Create `tests/scheduler/backends/redis-backend.test.ts` with integration tests
- [X] T010 [US1] Create `src/scheduler/backends/redis-backend.ts` with Redis sorted set implementation
- [X] T011 [US1] Implement priority scoring in redis backend (offset + timestamp for priority ordering)
- [X] T012 [US1] Implement atomic dequeue in redis backend (Lua script or WATCH/MULTI)
- [X] T013 [US1] Implement visibility timeout in redis backend (separate ZSET for processing jobs)
- [X] T014 [US1] Implement dead letter operations in redis backend
- [X] T015 [P] [US1] Create `src/scheduler/backends/index.ts` exporting both backends

## Phase 4: Job Scheduler Core

- [X] T016 [US1] Create `tests/scheduler/job-scheduler.test.ts` with scheduler tests
- [X] T017 [US1] Create `src/scheduler/job-scheduler.ts` with JobScheduler class skeleton
- [X] T018 [US1] Implement enqueue() - add job with priority, emit job:enqueued event
- [X] T019 [US1] Implement dequeue() - fetch highest priority job, emit job:started event
- [X] T020 [US1] Implement getJob() and updateJob() for job state management
- [X] T021 [US1] Implement pause() and resume() for processing control
- [X] T022 [US1] Implement getDeadLetterQueue() and retryDeadLetter() wrappers

## Phase 5: Job Processor and Retry Logic

- [X] T023 [US1] Create `tests/scheduler/retry.test.ts` with backoff calculation tests
- [X] T024 [US1] Create `tests/scheduler/job-processor.test.ts` with processor tests
- [X] T025 [US1] Create `src/scheduler/job-processor.ts` with JobProcessor class
- [X] T026 [US1] Implement process() loop - dequeue, execute, handle result
- [X] T027 [US1] Implement retry logic with exponential backoff (reuse calculateRetryDelay from src/utils/retry.ts)
- [X] T028 [US1] Implement job completion handling - acknowledge, emit job:completed
- [X] T029 [US1] Implement job failure handling - nack, increment attempts, emit job:failed
- [X] T030 [US1] Implement dead letter transition - emit job:dead when attempts >= maxAttempts

## Phase 6: Metrics and Health Checks

- [X] T031 [P] [US1] Implement periodic metrics:snapshot emission in JobScheduler
- [X] T032 [P] [US1] Implement healthCheck() method aggregating backend health status

## Phase 7: Integration and Exports

- [X] T033 Create `src/scheduler/index.ts` exporting public API (JobScheduler, types, backends)
- [X] T034 Update `src/index.ts` to export scheduler module
- [X] T035 Run full test suite and fix any failures
- [X] T036 Verify Redis backend with docker-compose redis service

## Dependencies & Execution Order

### Critical Path
1. **Types first** (T001-T003): All other code depends on type definitions
2. **Memory backend** (T004-T008): Enables testing without Redis
3. **Scheduler core** (T016-T022): Uses memory backend for initial testing
4. **Redis backend** (T009-T015): Can develop in parallel with processor once types exist
5. **Processor** (T023-T030): Depends on scheduler core
6. **Metrics/Health** (T031-T032): Can run in parallel after scheduler core
7. **Integration** (T033-T036): Final phase after all features complete

### Parallel Opportunities
- T002, T003 can run in parallel after T001
- T015, T031, T032 marked [P] can run in parallel with their phase
- Redis backend (T009-T014) can be developed in parallel with processor (T023-T030) once scheduler core exists

### Test-First Tasks
- T004 (memory backend tests) before T005-T008
- T009 (redis backend tests) before T010-T014
- T016 (scheduler tests) before T017-T022
- T023-T024 (retry/processor tests) before T025-T030
