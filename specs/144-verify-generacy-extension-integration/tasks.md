# Tasks: Verify Generacy Extension Integration

**Input**: Design documents from `/specs/144-verify-generacy-extension-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which verification area this task belongs to

## Phase 1: Environment Setup & Connectivity

- [ ] T001 Verify orchestrator starts on localhost:3001 with `pnpm dev` or docker-compose
- [ ] T002 [P] Confirm extension settings schema includes `generacy.cloudEndpoint` configuration
- [ ] T003 [P] Verify health endpoint `GET /health` responds with 200 OK
- [ ] T004 Test extension can reach orchestrator API using configured cloudEndpoint

## Phase 2: Authentication Verification

- [ ] T010 [AUTH] Generate test API key in orchestrator or configure in-memory store
- [ ] T011 [AUTH] Verify API key authentication via `X-API-Key` header works
- [ ] T012 [AUTH] [P] Test invalid API key returns 401 Unauthorized
- [ ] T013 [AUTH] [P] Verify JWT Bearer token authentication flow works
- [ ] T014 [AUTH] Test token refresh mechanism if session expires
- [ ] T015 [AUTH] Verify extension SecretStorage persists tokens across restarts

## Phase 3: Core API Verification - Workflows

- [ ] T020 [WORKFLOW] `POST /workflows` - Create a new workflow and verify response schema
- [ ] T021 [WORKFLOW] `GET /workflows` - List workflows and verify Zod schema validation
- [ ] T022 [WORKFLOW] [P] `GET /workflows/:id` - Get single workflow details
- [ ] T023 [WORKFLOW] [P] `POST /workflows/:id/pause` - Pause running workflow
- [ ] T024 [WORKFLOW] [P] `POST /workflows/:id/resume` - Resume paused workflow
- [ ] T025 [WORKFLOW] Verify workflow status transitions: created → running → paused → completed

## Phase 4: Core API Verification - Queue

- [ ] T030 [QUEUE] `GET /queue` - List decision queue items with proper filtering
- [ ] T031 [QUEUE] `GET /queue/:id` - Get single queue item details
- [ ] T032 [QUEUE] [P] `POST /queue/:id/respond` - Submit decision response
- [ ] T033 [QUEUE] Verify queue item priority levels: blocking_now, blocking_soon, when_available
- [ ] T034 [QUEUE] Test queue item schema matches expected format (type, prompt, options)

## Phase 5: Extension UI Verification (Manual)

- [ ] T040 [MANUAL] [UI] Open Organization Dashboard view and verify it loads without errors
- [ ] T041 [MANUAL] [UI] Verify dashboard displays org data matching API response
- [ ] T042 [MANUAL] [UI] Open Queue tree view and confirm items display correctly
- [ ] T043 [MANUAL] [UI] Test queue item interaction - view details, submit response
- [ ] T044 [MANUAL] [UI] Verify error messages display clearly on connection failure
- [ ] T045 [MANUAL] [UI] Test publish workflow command and verify sync status

## Phase 6: Error Handling & Edge Cases

- [ ] T050 [P] Test connection failure error handling when orchestrator is not running
- [ ] T051 [P] Verify timeout handling with appropriate retry logic
- [ ] T052 [P] Test schema validation error handling for malformed responses
- [ ] T053 Verify 404 handling for non-existent workflow/queue items
- [ ] T054 Test rate limiting response handling if implemented

## Phase 7: Integration Test Suite

- [ ] T060 Create integration test file `tests/integration/extension-orchestrator.test.ts`
- [ ] T061 [P] Write test: Health check connectivity
- [ ] T062 [P] Write test: API key authentication flow
- [ ] T063 [P] Write test: Workflow CRUD operations
- [ ] T064 [P] Write test: Queue operations
- [ ] T065 Run full integration test suite and verify all tests pass

## Dependencies & Execution Order

### Sequential Dependencies
1. **Phase 1 → Phase 2**: Environment must be running before auth testing
2. **Phase 2 → Phases 3-4**: Authentication must work before API calls
3. **Phases 3-4 → Phase 5**: Core APIs must work before UI verification
4. **Phases 3-4 → Phase 6**: Core flows must work before testing edge cases
5. **Phases 3-6 → Phase 7**: All manual verification before writing integration tests

### Parallel Opportunities
- Within Phase 1: T002 and T003 can run in parallel (independent checks)
- Within Phase 2: T012 and T013 can run in parallel (different auth methods)
- Within Phase 3: T022, T023, T024 can run in parallel (independent endpoints)
- Within Phase 4: T032 can run in parallel with other queue operations
- Within Phase 5: All UI tasks are independent but manual
- Within Phase 6: T050, T051, T052 can run in parallel (different error scenarios)
- Within Phase 7: T061, T062, T063, T064 can run in parallel (independent test files)

### Key Notes
- **[MANUAL]** tasks require visual inspection and human judgment
- API key auth (T010-T011) is the primary path for local development
- OAuth flow verification is lower priority but should be documented if gaps found
- Document any API mismatches discovered (extension expects `/orgs/*`, orchestrator has `/workflows/*`)
