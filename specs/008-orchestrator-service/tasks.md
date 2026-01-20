# Tasks: Orchestrator Service

**Input**: Design documents from `/specs/008-orchestrator-service/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/openapi.yaml
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Project Setup and Configuration

- [x] T001 Create `packages/orchestrator/package.json` with Fastify v5, Zod, ioredis, and dev dependencies
- [x] T002 [P] Create `packages/orchestrator/tsconfig.json` extending root config with ESM settings
- [x] T003 [P] Create `src/types/problem-details.ts` - RFC 7807 ProblemDetails interface and ErrorTypes constants
- [x] T004 [P] Create `src/types/api.ts` - Request/response types (CreateWorkflowRequest, WorkflowResponse, etc.)
- [x] T005 [P] Create `src/types/websocket.ts` - WebSocket message types (ClientMessage, ServerMessage, Channel)
- [x] T006 Create `src/types/index.ts` - Export all types
- [x] T007 Create `src/config/schema.ts` - Zod schema for OrchestratorConfig
- [x] T008 Create `src/config/loader.ts` - Environment variable and YAML config loading
- [x] T009 Create `src/config/index.ts` - Export config loader and schema

## Phase 2: Server Foundation and Utilities

- [x] T010 Create `src/utils/correlation.ts` - Request correlation ID middleware (X-Request-ID)
- [x] T011 [P] Create `src/utils/shutdown.ts` - Graceful shutdown handler (SIGTERM, SIGINT)
- [x] T012 Create `src/utils/index.ts` - Export utilities
- [x] T013 Create `src/server.ts` - Fastify server setup with cors, helmet, websocket plugins
- [x] T014 Write `tests/unit/utils/correlation.test.ts` - Test correlation ID generation
- [x] T015 [P] Write `tests/unit/utils/shutdown.test.ts` - Test graceful shutdown sequence

## Phase 3: Authentication

- [x] T016 Create `src/auth/api-key.ts` - API key validation (X-API-Key header)
- [x] T017 [P] Create `src/auth/jwt.ts` - JWT token creation, validation, and payload types
- [x] T018 Create `src/auth/github-oauth.ts` - GitHub OAuth2 flow (authorization URL, callback, token exchange)
- [x] T019 Create `src/auth/middleware.ts` - Fastify preHandler hook that validates API key or JWT
- [x] T020 Create `src/auth/index.ts` - Export auth modules
- [x] T021 Write `tests/unit/auth/api-key.test.ts` - Test API key validation
- [x] T022 [P] Write `tests/unit/auth/jwt.test.ts` - Test JWT creation and validation

## Phase 4: Middleware

- [x] T023 Create `src/middleware/rate-limit.ts` - Per-API-key rate limiting with @fastify/rate-limit + Redis
- [x] T024 [P] Create `src/middleware/request-logger.ts` - Structured pino logging with correlation ID
- [x] T025 Create `src/middleware/error-handler.ts` - Global error handler returning RFC 7807 format
- [x] T026 Create `src/middleware/index.ts` - Export middleware
- [x] T027 Write `tests/unit/middleware/rate-limit.test.ts` - Test rate limit key generation and enforcement
- [x] T028 [P] Write `tests/unit/middleware/error-handler.test.ts` - Test error formatting

## Phase 5: Services Layer

- [x] T029 Create `src/services/workflow-service.ts` - Facade over WorkflowEngine (#3) for CRUD operations
- [x] T030 [P] Create `src/services/queue-service.ts` - Decision queue operations via MessageRouter (#5)
- [x] T031 [P] Create `src/services/agent-registry.ts` - Track connected agents with connection status
- [x] T032 Create `src/services/index.ts` - Export services
- [x] T033 Write `tests/unit/services/workflow-service.test.ts` - Test workflow service with mocked engine
- [x] T034 [P] Write `tests/unit/services/queue-service.test.ts` - Test queue service with mocked router

## Phase 6: HTTP Routes

- [x] T035 Create `src/routes/health.ts` - GET /health endpoint with service status checks
- [x] T036 [P] Create `src/routes/metrics.ts` - GET /metrics endpoint with Prometheus prom-client
- [x] T037 Create `src/routes/workflows.ts` - POST/GET/DELETE /workflows, POST /workflows/:id/pause|resume
- [x] T038 [P] Create `src/routes/queue.ts` - GET /queue, POST /queue/:id/respond
- [x] T039 [P] Create `src/routes/agents.ts` - GET /agents endpoint
- [x] T040 [P] Create `src/routes/integrations.ts` - GET /integrations endpoint
- [x] T041 Create `src/routes/index.ts` - Route registration function
- [x] T042 Write `tests/integration/routes/health.test.ts` - Test health endpoint
- [x] T043 [P] Write `tests/integration/routes/workflows.test.ts` - Test workflow CRUD endpoints
- [x] T044 [P] Write `tests/integration/routes/queue.test.ts` - Test queue endpoints

## Phase 7: WebSocket Support

- [x] T045 Create `src/websocket/messages.ts` - Zod schemas for ClientMessage and ServerMessage validation
- [x] T046 Create `src/websocket/subscriptions.ts` - Channel subscription manager (subscribe, unsubscribe, broadcast)
- [x] T047 Create `src/websocket/handler.ts` - WebSocket connection handler with auth via preHandler
- [x] T048 Create `src/websocket/index.ts` - Export WebSocket modules
- [x] T049 Write `tests/integration/websocket/subscriptions.test.ts` - Test subscription and broadcast

## Phase 8: Entry Points and Integration

- [x] T050 Create `src/index.ts` - Public exports (createServer, types, config)
- [x] T051 Integrate all plugins and routes in `src/server.ts` with proper initialization order
- [x] T052 Write `tests/integration/server.test.ts` - Full server lifecycle test (start, request, shutdown)

## Phase 9: Docker and Documentation

- [x] T053 Create `Dockerfile` - Multi-stage build (build + production alpine image)
- [x] T054 Create `tests/fixtures/workflows.ts` - Test workflow fixtures
- [x] T055 [P] Create `tests/fixtures/auth.ts` - Test auth fixtures (API keys, JWT tokens)

---

## Dependencies & Execution Order

### Sequential Dependencies
1. **T001** (package.json) must complete before any implementation starts
2. **T002** (tsconfig) can run in parallel with T001 but blocks implementation
3. **T003-T006** (types) must complete before services and routes
4. **T007-T009** (config) must complete before T013 (server)
5. **T013** (server) must complete before routes (T035-T044)
6. **T016-T020** (auth) must complete before T019 (auth middleware) which is used in routes
7. **T029-T032** (services) should complete before routes that use them
8. **T045-T048** (WebSocket) depends on auth middleware and types

### Parallel Opportunities
- **Phase 1**: T002, T003, T004, T005 can all run in parallel after T001
- **Phase 2**: T010 and T011 can run in parallel
- **Phase 3**: T016, T017, T018 can partially run in parallel
- **Phase 4**: T023, T024, T025 can run in parallel
- **Phase 5**: T029, T030, T031 can run in parallel
- **Phase 6**: T035-T040 routes can mostly run in parallel after services
- **Phase 9**: T054 and T055 can run in parallel

### Test Execution
- Unit tests (Phase 2-5) should be written alongside their implementation
- Integration tests (Phase 6-8) require the full server setup
- Consider running tests in CI after each phase completion

---

*Generated by speckit*
