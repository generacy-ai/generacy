# Tasks: Concrete HumanDecisionHandler for Humancy API

**Input**: Design documents from `specs/183-humancy-decision-handler/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (required)
**Status**: Ready
**Parent Epic**: #182

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel with other [P] tasks in the same phase (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

---

## Phase 1: Orchestrator Prerequisites

> Add missing `POST /queue` endpoint and relax validation for external workflow IDs.

### T001 [US1] Relax `workflowId` validation in orchestrator types
**File**: `packages/orchestrator/src/types/api.ts`
- Change `DecisionQueueItemSchema.workflowId` from `z.string().uuid()` to `z.string().min(1)`
- Change `QueueQuerySchema.workflowId` from `z.string().uuid().optional()` to `z.string().optional()`

**File**: `packages/orchestrator/src/routes/queue.ts`
- Update the `GET /queue` route schema: remove `format: 'uuid'` from the `workflowId` query property

**File**: `packages/orchestrator/src/types/sse.ts`
- Update `SSEQuerySchema.workflowId` from `z.string().uuid().optional()` to `z.string().optional()`
- Update `SSEFiltersSchema.workflowId` from `z.string().uuid().optional()` to `z.string().optional()`

### T002 [US1] Add `CreateDecisionRequestSchema` to orchestrator types
**File**: `packages/orchestrator/src/types/api.ts`
- Add `CreateDecisionRequestSchema` Zod schema with fields: `workflowId`, `stepId`, `type`, `prompt`, `options`, `context`, `priority`, `expiresAt`, `agentId`
- Export the schema and inferred `CreateDecisionRequest` type
- Reuse existing `DecisionTypeSchema`, `DecisionOptionSchema`, and `DecisionPrioritySchema`

### T003 [US1] Add `createDecision()` method to `MessageRouter` and `InMemoryQueueStore`
**File**: `packages/orchestrator/src/services/queue-service.ts`
- Add `createDecision(request: CreateDecisionRequest): Promise<DecisionQueueItem>` to `MessageRouter` interface
- Implement in `InMemoryQueueStore`: generate UUID `id`, set `createdAt` to `new Date().toISOString()`, construct full `DecisionQueueItem`, store in queue map
- Add `createDecision()` to `QueueService` facade: delegate to router

### T004 [US1] Add `POST /queue` route to orchestrator
**File**: `packages/orchestrator/src/routes/queue.ts`
- Add `POST /queue` route with `requireWrite('queue')` middleware
- Parse body with `CreateDecisionRequestSchema`
- Call `queueService.createDecision()`
- Return `201` with the created `DecisionQueueItem`
- Add OpenAPI schema description and tags

### T005 [P] [US1] Extend `QueueEventData` with optional `response` field
**File**: `packages/orchestrator/src/types/sse.ts`
- Add `response?: DecisionResponse` to `QueueEventData` interface
- Import `DecisionResponse` from `./api.js`

### T006 [US1] Wire SSE event emission on decision creation and response
**File**: `packages/orchestrator/src/routes/queue.ts` (or service layer)
- After `queueService.createDecision()` in `POST /queue`, broadcast `queue:item:added` SSE event via subscription manager
- After `queueService.respond()` in `POST /queue/:id/respond`, broadcast `queue:item:removed` SSE event with the `DecisionResponse` included in event data
- Verify subscription manager is accessible from route context (may need to pass via route setup or singleton `getSSESubscriptionManager()`)

**File**: `packages/orchestrator/src/sse/events.ts`
- Extend `createQueueEvent()` signature to accept an optional `response?: DecisionResponse` parameter
- Include `response` in the returned `QueueSSEEvent.data` when provided

### T007 [P] [US1] Export new types from orchestrator package
**File**: `packages/orchestrator/src/types/index.ts`
- Export `CreateDecisionRequestSchema` and `CreateDecisionRequest` type

**File**: `packages/orchestrator/src/index.ts`
- Export `CreateDecisionRequest` type from the public API

---

## Phase 2: Core Handler Implementation

> Create the `HumancyApiDecisionHandler` class with full lifecycle management.

### T008 [US2] Create `CorrelationTimeoutError` class
**File**: `packages/workflow-engine/src/errors/correlation-timeout.ts` (CREATE)
- Create error class extending `Error`
- Set `this.name = 'CorrelationTimeoutError'` (required by `HumancyReviewAction` line 242)
- Accept `message: string` and optional `decisionId?: string` constructor params

### T009 [US1] Create `HumancyApiDecisionHandler` class — config and constructor
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts` (CREATE)
- Define `HumancyApiHandlerConfig` interface with fields: `apiUrl`, `agentId`, `projectId?`, `authToken?`, `fallbackToSimulation?` (default `true`), `sseReconnectDelay?` (default `1000`), `maxReconnectAttempts?` (default `10`)
- Define optional `Logger` interface (or accept one matching `context.logger` shape)
- Create class implementing `HumanDecisionHandler` interface
- Constructor stores config with defaults applied

### T010 [US1] Implement request-to-payload mapping
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- Implement private `mapRequestToPayload(request: ReviewDecisionRequest, timeout: number)` method
- Map `title` → `prompt`
- Map `description` → `context.description`
- Map `artifact` → `context.artifact`
- Map `options` directly (drop `requiresComment`, include as `description` hint)
- Map `urgency` → `priority`: `low`/`normal` → `when_available`, `blocking_soon` → `blocking_soon`, `blocking_now` → `blocking_now`
- Map `workflowId` → `workflowId`, `stepId` → `stepId`
- Set `type: 'review'`
- Set `agentId` from config
- Set `expiresAt` to `new Date(Date.now() + timeout + 5 * 60 * 1000).toISOString()`

### T011 [US1] Implement response mapping
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- Implement private `mapResponse(response: DecisionResponse, request: ReviewDecisionRequest)` method
- `response: true` → `{ approved: true }`
- `response: false` → `{ approved: false }`
- `response: string` → `{ decision: response, approved: response === request.options[0]?.id }`
- `response: string[]` → `{ decision: response[0], approved: response[0] === request.options[0]?.id }`
- Map `comment` → `input`
- Map `respondedBy` → `respondedBy`
- Map `respondedAt` → `respondedAt`

### T012 [US1] Implement SSE stream parser
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- Implement private async generator or callback-based SSE parser for `fetch()` streaming body
- Parse SSE text protocol: `event:` lines, `data:` lines (join multi-line with newline), `id:` lines, empty line = dispatch
- Ignore comment lines (starting with `:`)
- Track `lastEventId` for reconnection
- Yield parsed events as `{ event: string, data: string, id: string }`

### T013 [US1] Implement SSE connection with reconnection logic
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- Implement private `connectSSE(workflowId: string, signal: AbortSignal)` method
- Connect to `GET {apiUrl}/events?channels=queue` with `Authorization: Bearer {authToken}` header
- On stream error/close before resolution: reconnect with `Last-Event-ID` header
- Respect `maxReconnectAttempts` and `sseReconnectDelay` config
- Use `AbortSignal` to support cancellation from the timeout controller

### T014 [US1] Implement `requestDecision()` main method
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- Implement public `requestDecision(request, timeout)` method
- Create `AbortController` for timeout management
- Set up `setTimeout` for timeout → abort + throw `CorrelationTimeoutError`
- Step 1: Map request to payload via `mapRequestToPayload()`
- Step 2: `POST {apiUrl}/queue` with mapped payload (use native `fetch()` with abort signal)
- Step 3: On POST failure → check fallback logic (T015)
- Step 4: Extract `id` from created `DecisionQueueItem` response
- Step 5: Connect to SSE stream via `connectSSE()`
- Step 6: Wait for `queue:item:removed` event where `data.item.id === decisionId`
- Step 7: Extract `response` from event data (`data.response`)
- Step 8: Map response via `mapResponse()`
- Step 9: Clean up — clear timeout, close SSE connection
- Return mapped `ReviewDecisionResponse`

### T015 [US4] Implement simulation fallback on API failure
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- On POST failure: classify error as network (connection refused, DNS, fetch abort), 5xx, or 4xx
- If `fallbackToSimulation` is true AND error is network or 5xx: log warning, return `{ approved: true, respondedBy: 'simulated', respondedAt: new Date().toISOString() }`
- If 4xx: always throw (misconfiguration — fail loudly)
- If `fallbackToSimulation` is false: always throw

### T016 [P] [US2] Implement logging throughout handler lifecycle
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.ts`
- `info`: Decision created (ID, workflowId, stepId)
- `debug`: SSE connected, SSE event received (event type, ID)
- `info`: Decision resolved (ID, approved/rejected)
- `warn`: SSE reconnecting (attempt N of max), falling back to simulation
- `error`: Decision timed out, unrecoverable network error

---

## Phase 3: Worker Wiring

> Inject the handler into the worker when environment variables are set.

### T017 [US3] Add `humanDecisionHandler` option to `JobHandler`
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Add optional `humanDecisionHandler?: HumanDecisionHandler` to `JobHandlerOptions` interface
- After `registerBuiltinActions()` call in constructor:
  - If `options.humanDecisionHandler` is provided, call `getActionHandlerByType('humancy.request_review')`
  - Cast result to `HumancyReviewAction` and call `setHumanHandler(options.humanDecisionHandler)`
- Import `HumanDecisionHandler`, `HumancyReviewAction`, and `getActionHandlerByType` from workflow-engine

### T018 [US3] Create handler from environment variables in worker command
**File**: `packages/generacy/src/cli/commands/worker.ts`
- Read `HUMANCY_API_URL`, `HUMANCY_AGENT_ID`, `HUMANCY_AUTH_TOKEN` from `process.env`
- Fall back: `agentId` defaults to `workerId`, `authToken` falls back to `ORCHESTRATOR_TOKEN`
- When `HUMANCY_API_URL` is set: create `HumancyApiDecisionHandler` instance with config
- Log `info` when handler is configured
- Pass `humanDecisionHandler` to `JobHandler` constructor options
- When `HUMANCY_API_URL` is not set: no handler created (existing simulation behavior preserved)

---

## Phase 4: Package Exports

> Export new types and classes from package entry points.

### T019 [P] [US1] Export handler and error from workflow-engine
**File**: `packages/workflow-engine/src/actions/index.ts`
- Export `HumancyApiDecisionHandler` and `HumancyApiHandlerConfig` type from `./builtin/humancy-api-handler.js`
- Export `CorrelationTimeoutError` from `../../errors/correlation-timeout.js` (or adjust path)

**File**: `packages/workflow-engine/src/index.ts`
- Re-export `HumancyApiDecisionHandler`, `HumancyApiHandlerConfig`, and `CorrelationTimeoutError` from `./actions/index.js`

---

## Phase 5: Testing

> Comprehensive unit tests for handler logic and orchestrator additions.

### T020 [US1] Write unit tests for request-to-payload mapping
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts` (CREATE)
- Test all urgency → priority combinations: `low` → `when_available`, `normal` → `when_available`, `blocking_soon` → `blocking_soon`, `blocking_now` → `blocking_now`
- Test `title` → `prompt` mapping
- Test `description` → `context.description` mapping
- Test `artifact` → `context.artifact` mapping
- Test `options` mapping with `requiresComment` → `description` hint
- Test `expiresAt` calculation: `timeout + 5 min` buffer
- Test `agentId` from config is included

### T021 [US1] Write unit tests for response mapping
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Test `response: true` → `{ approved: true }`
- Test `response: false` → `{ approved: false }`
- Test `response: 'approve'` → `{ approved: true, decision: 'approve' }`
- Test `response: 'reject'` → `{ approved: false, decision: 'reject' }`
- Test `response: ['approve']` (array) → `{ approved: true, decision: 'approve' }`
- Test `comment` → `input` mapping
- Test `respondedBy` and `respondedAt` passthrough

### T022 [US1] Write unit tests for happy path — full request-response cycle
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Mock `global.fetch` for POST `/queue` success → return `DecisionQueueItem` with UUID `id`
- Mock `global.fetch` for GET `/events` SSE stream → emit `queue:item:removed` event with matching `id` and included `response`
- Verify `requestDecision()` returns correctly mapped `ReviewDecisionResponse`
- Verify SSE connection is closed after resolution

### T023 [US2] Write unit tests for timeout enforcement
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Configure short timeout (e.g., 100ms)
- Mock SSE stream that never fires the matching event
- Verify `CorrelationTimeoutError` is thrown within tolerance of configured timeout
- Verify `error.name === 'CorrelationTimeoutError'`
- Verify SSE connection is aborted/closed on timeout

### T024 [US4] Write unit tests for simulation fallback
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Test POST failure with network error (fetch throws `TypeError`) → simulated approval returned
- Test POST failure with 503 → simulated approval returned
- Test POST failure with 401 → error thrown (no fallback)
- Test POST failure with 400 → error thrown (no fallback)
- Test `fallbackToSimulation: false` → all errors throw

### T025 [US2] Write unit tests for SSE reconnection
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Mock SSE stream that closes after 2 events, then succeeds on reconnection
- Verify reconnection with `Last-Event-ID` header
- Verify reconnection respects `maxReconnectAttempts` limit
- Verify failure after max attempts exhausted

### T026 [US2] Write unit tests for resource cleanup
**File**: `packages/workflow-engine/src/actions/builtin/humancy-api-handler.test.ts`
- Verify SSE connection closed after successful resolution
- Verify SSE connection closed after timeout
- Verify SSE connection closed after POST failure with fallback
- Verify `clearTimeout` called on success (no dangling timers)

### T027 [P] [US1] Write orchestrator tests for `POST /queue` route
**File**: `packages/orchestrator/src/routes/queue.test.ts` (or existing test file)
- Test valid creation: POST with correct payload → 201 + `DecisionQueueItem` returned
- Test validation errors: missing required fields → 400
- Test auth requirement: no token → 401
- Test that created decision appears in `GET /queue` response
- Test that SSE `queue:item:added` event is emitted on creation

### T028 [P] [US1] Write orchestrator tests for SSE response inclusion
**File**: `packages/orchestrator/src/routes/queue.test.ts` (or SSE test file)
- Verify `POST /queue/:id/respond` emits `queue:item:removed` SSE event
- Verify SSE event data includes `response` field with `DecisionResponse`
- Verify `response.respondedBy`, `response.comment`, `response.respondedAt` are present

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (handler depends on `POST /queue` and SSE enhancements)
- Phase 2 must complete before Phase 3 (wiring depends on handler class existing)
- Phase 4 can run after Phase 2 (only needs handler file to exist)
- Phase 5 can begin partially during Phase 2 (mapping tests don't need full integration)

**Parallel opportunities within phases**:

Phase 1:
- T001, T002 can run in parallel (independent schema changes in same file — but may conflict, recommend sequential)
- T005 is independent (different file: `sse.ts`) — can run with T001–T004
- T007 is independent (export-only) — can run with T005–T006

Phase 2:
- T008 (error class) is independent — can run with T009
- T016 (logging) can run alongside T014 if stubbed first
- T009–T015 are mostly sequential within the same file

Phase 5:
- T020–T026 are in the same file but can be written incrementally
- T027, T028 are in orchestrator package — can run in parallel with T020–T026

**Critical path**:
```
T001 → T002 → T003 → T004 → T006 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T017 → T018 → T022
```

**Summary**:
- **28 tasks** across **5 phases**
- **Phase 1**: 7 tasks (orchestrator prerequisites)
- **Phase 2**: 9 tasks (core handler)
- **Phase 3**: 2 tasks (worker wiring)
- **Phase 4**: 1 task (exports)
- **Phase 5**: 9 tasks (testing)
