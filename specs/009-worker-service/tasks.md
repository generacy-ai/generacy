# Tasks: Worker Service

**Input**: Design documents from `/specs/009-worker-service/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup & Types

- [ ] T001 Create worker module structure (`src/worker/index.ts` - exports)
- [ ] T002 [P] Define worker types and interfaces (`src/worker/types.ts`)
- [ ] T003 [P] Create configuration schema with defaults (`src/worker/config/worker-config.ts`, `src/worker/config/defaults.ts`)
- [ ] T004 [P] Add configuration index exports (`src/worker/config/index.ts`)

## Phase 2: Tests First (TDD)

- [ ] T010 [P] [US1] Write unit tests for WorkerProcessor lifecycle (`tests/worker/worker-processor.test.ts`)
- [ ] T011 [P] [US2] Write unit tests for AgentHandler (`tests/worker/handlers/agent-handler.test.ts`)
- [ ] T012 [P] [US3] Write unit tests for HumanHandler (`tests/worker/handlers/human-handler.test.ts`)
- [ ] T013 [P] Write unit tests for IntegrationHandler (`tests/worker/handlers/integration-handler.test.ts`)
- [ ] T014 [P] [US1] Write unit tests for retry policies (`tests/worker/retry/retry-policy.test.ts`)
- [ ] T015 [P] [US4] Write unit tests for HealthServer (`tests/worker/health/health-server.test.ts`)
- [ ] T016 [P] [US4] Write unit tests for Heartbeat (`tests/worker/health/heartbeat.test.ts`)

## Phase 3: Core Implementation

### Retry Policies
- [ ] T020 [US1] Implement ExponentialBackoffPolicy for agent jobs (`src/worker/retry/retry-policy.ts`)
- [ ] T021 [P] Implement NoRetryPolicy for human jobs (`src/worker/retry/retry-policy.ts`)
- [ ] T022 [P] Implement StatusCodeRetryPolicy for integration jobs (`src/worker/retry/retry-policy.ts`)
- [ ] T023 Add retry module exports (`src/worker/retry/index.ts`)

### Job Handlers
- [ ] T030 [US2] Implement AgentHandler with registry integration (`src/worker/handlers/agent-handler.ts`)
- [ ] T031 [US3] Implement HumanHandler with router integration (`src/worker/handlers/human-handler.ts`)
- [ ] T032 Implement IntegrationHandler (`src/worker/handlers/integration-handler.ts`)
- [ ] T033 Add handlers module exports (`src/worker/handlers/index.ts`)

### Worker Processor
- [ ] T040 [US1] Implement WorkerProcessor core (start/stop, process loop) (`src/worker/worker-processor.ts`)
- [ ] T041 [US1] Add job dispatching to handlers by type (`src/worker/worker-processor.ts`)
- [ ] T042 [US4] Add graceful shutdown logic with timeout (`src/worker/worker-processor.ts`)
- [ ] T043 Add event emission for observability (`src/worker/worker-processor.ts`)

## Phase 4: Health & Monitoring

- [ ] T050 [US4] Implement HealthServer with /health, /health/live, /health/ready (`src/worker/health/health-server.ts`)
- [ ] T051 [P] [US4] Implement Redis Heartbeat publisher (`src/worker/health/heartbeat.ts`)
- [ ] T052 Add health module exports (`src/worker/health/index.ts`)

## Phase 5: Integration & Polish

- [ ] T060 [US4] Add shutdown signal handlers (SIGTERM, SIGINT) (`src/worker/worker-processor.ts`)
- [ ] T061 [P] Create worker factory function (`src/worker/index.ts`)
- [ ] T062 Write integration test: full job processing flow (`tests/worker/integration/job-processing.test.ts`)
- [ ] T063 [P] Write integration test: graceful shutdown (`tests/worker/integration/graceful-shutdown.test.ts`)
- [ ] T064 Update module exports in main index (`src/worker/index.ts`)

## Phase 6: Docker & Deployment

- [ ] T070 Create Dockerfile for worker service (`docker/worker/Dockerfile`)
- [ ] T071 [P] Create docker-compose entry for local development (`docker/docker-compose.worker.yml`)
- [ ] T072 Verify Docker image builds and runs (`manual validation`)

---

## Dependencies & Execution Order

### Sequential Dependencies
1. **T001** → All other tasks (module structure must exist first)
2. **T002, T003** → T010-T016 (types needed for tests)
3. **T010-T016** → T020-T052 (TDD: tests before implementation)
4. **T020-T023** → T040-T043 (retry policies used by processor)
5. **T030-T033** → T040-T043 (handlers used by processor)
6. **T040-T043** → T050-T052 (processor instantiated with health components)
7. **T050-T052** → T060-T064 (health components for integration tests)
8. **T064** → T070-T072 (complete module before Docker)

### Parallel Opportunities
- **Phase 1**: T002, T003, T004 can run in parallel
- **Phase 2**: All test files can be written in parallel
- **Phase 3**: Retry policies (T020-T022) can run in parallel; Handlers (T030-T032) can run in parallel
- **Phase 4**: T050 and T051 can run in parallel
- **Phase 5**: T061 and T063 can run in parallel with T062
- **Phase 6**: T070 and T071 can run in parallel

### External Dependencies
- **Job Scheduler** (#6): `dequeue()`, `acknowledge()`, `nack()` methods
- **Agent Registry** (#4): `get()` method returning `AgentInvoker`
- **Message Router** (#5): `routeToHumancy()`, `waitForCorrelation()` methods

---

*Generated by speckit*
