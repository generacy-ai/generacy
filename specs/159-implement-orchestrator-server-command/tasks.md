# Tasks: Implement Orchestrator Server Command

**Input**: Design documents from `/specs/159-implement-orchestrator-server-command/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Infrastructure

- [X] T001 [US1] Create worker registry module `packages/generacy/src/orchestrator/worker-registry.ts` with `WorkerRegistry` interface
- [X] T002 [P] [US3] Create job queue interface and in-memory implementation `packages/generacy/src/orchestrator/job-queue.ts`
- [X] T003 Create HTTP router utility for path matching with parameter extraction in `packages/generacy/src/orchestrator/router.ts`

## Phase 2: Server Implementation

- [X] T004 [US1] Implement orchestrator HTTP server `packages/generacy/src/orchestrator/server.ts` with route handling
- [X] T005 [US1] [US2] Implement worker registration endpoint `POST /api/workers/register`
- [X] T006 [US2] Implement worker unregistration endpoint `DELETE /api/workers/:id`
- [X] T007 [US2] Implement heartbeat endpoint `POST /api/workers/:id/heartbeat`
- [X] T008 [US3] Implement job poll endpoint `GET /api/jobs/poll`
- [X] T009 [US3] Implement job status update endpoint `PUT /api/jobs/:id/status`
- [X] T010 [US3] Implement job result endpoint `POST /api/jobs/:id/result`
- [X] T011 [US3] Implement get job endpoint `GET /api/jobs/:id`
- [X] T012 [US3] Implement cancel job endpoint `POST /api/jobs/:id/cancel`
- [X] T013 [US1] Implement health check endpoint `GET /api/health`

## Phase 3: CLI Command

- [X] T014 [US1] Create orchestrator CLI command `packages/generacy/src/cli/commands/orchestrator.ts` with options parsing
- [X] T015 [US1] Register orchestrator command in CLI index `packages/generacy/src/cli/index.ts`
- [X] T016 [US1] Add graceful shutdown handling with signal handlers (SIGTERM, SIGINT)

## Phase 4: Testing

- [X] T017 [P] Write unit tests for WorkerRegistry `packages/generacy/src/orchestrator/__tests__/worker-registry.test.ts`
- [X] T018 [P] Write unit tests for JobQueue (in-memory) `packages/generacy/src/orchestrator/__tests__/job-queue.test.ts`
- [X] T019 [P] Write unit tests for HTTP router `packages/generacy/src/orchestrator/__tests__/router.test.ts`
- [X] T020 Write integration tests for orchestrator server API endpoints `packages/generacy/src/orchestrator/__tests__/server.test.ts`

## Phase 5: Optional Enhancements

- [ ] T021 [P] Implement Redis job queue backend `packages/generacy/src/orchestrator/redis-job-queue.ts`
- [ ] T022 [P] Add optional Bearer token authentication middleware

## Dependencies & Execution Order

**Phase 1** (Setup - can run T001 and T002 in parallel):
- T001 (worker registry) and T002 (job queue) have no dependencies, can run in parallel
- T003 (router) has no dependencies, can run in parallel with T001/T002

**Phase 2** (Server - sequential, depends on Phase 1):
- T004 depends on T001, T002, T003 (needs registry, queue, and router)
- T005-T013 depend on T004 (server framework must exist)
- T005-T013 should be implemented in order for incremental testing

**Phase 3** (CLI - depends on Phase 2):
- T014 depends on T004 (needs server to instantiate)
- T015 depends on T014
- T016 depends on T014

**Phase 4** (Testing - unit tests can run in parallel):
- T017, T018, T019 can run in parallel (unit tests)
- T020 depends on T004-T016 (integration test needs full server)

**Phase 5** (Optional - can run in parallel):
- T021 and T022 can run in parallel
- Both depend on Phase 2 completion

## Notes

- All API endpoints use `/api` prefix to match existing `OrchestratorClient`
- Use native Node.js `http` module (no Express/Fastify) per design decision
- In-memory queue logs warning about data loss on startup
- Authentication is optional - only enforced when `ORCHESTRATOR_TOKEN` is set
- Worker timeout defaults to 60000ms, matching client expectations
