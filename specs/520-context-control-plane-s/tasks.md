# Tasks: Control-plane mutator routes should reject missing actor with 401

**Input**: Design documents from `/specs/520-context-control-plane-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Add `UNAUTHORIZED` error code to `ControlPlaneErrorCode` union and `HTTP_STATUS_MAP` in `packages/control-plane/src/errors.ts`
- [X] T002 [US1] Add `requireActor(actor: ActorContext): void` guard function in `packages/control-plane/src/context.ts` — throws `ControlPlaneError('UNAUTHORIZED', 'Missing actor identity')` when `actor.userId` is falsy
- [X] T003 [P] [US1] Call `requireActor(actor)` in `handlePutCredential` in `packages/control-plane/src/routes/credentials.ts` — rename `_actor` → `actor`, add guard as first statement
- [X] T004 [P] [US1] Call `requireActor(actor)` in `handlePutRole` in `packages/control-plane/src/routes/roles.ts` — rename `_actor` → `actor`, add guard as first statement
- [X] T005 [P] [US1] Call `requireActor(actor)` in `handlePostLifecycle` in `packages/control-plane/src/routes/lifecycle.ts` — rename `_actor` → `actor`, add guard as first statement

## Phase 2: Tests

- [X] T006 [US1] Add tests: PUT /credentials/:id without actor header returns 401 with `{ error: "Missing actor identity", code: "UNAUTHORIZED" }`
- [X] T007 [P] [US1] Add tests: PUT /roles/:id without actor header returns 401
- [X] T008 [P] [US1] Add tests: POST /lifecycle/:action without actor header returns 401
- [X] T009 [P] [US1] Add tests: PUT/POST routes WITH `x-generacy-actor-user-id` header return 200 (existing behavior preserved)
- [X] T010 [P] [US2] Add tests: GET /state, GET /credentials/:id, GET /roles/:id without actor headers return 200
- [X] T011 [P] [US1] Add tests: Internal routes (POST /internal/audit-batch, POST /internal/status) without actor headers return 200

## Dependencies & Execution Order

1. **T001 → T002**: `requireActor` depends on the `UNAUTHORIZED` error code existing
2. **T002 → T003, T004, T005**: Route guards depend on `requireActor` being defined
3. **T003, T004, T005** are parallelizable (different files, no shared state)
4. **Phase 2 depends on Phase 1**: Tests validate the implementation
5. **T006–T011** are all parallelizable (independent test cases, can be in same or separate test files)
