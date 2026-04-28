# Tasks: Cloud-Hosted Bootstrap Control-Plane Service

**Input**: Design documents from `/specs/490-context-cloud-hosted-bootstrap/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Package Scaffold & Error Infrastructure

- [ ] T001 Create `packages/control-plane/package.json` mirroring credhelper-daemon structure (name: `@generacy-ai/control-plane`, type: module, deps: `@generacy-ai/credhelper` workspace:*, zod, devDeps: @types/node, typescript, vitest)
- [ ] T002 [P] Create `packages/control-plane/tsconfig.json` (ES2022, NodeNext, strict — identical compiler options to credhelper-daemon)
- [ ] T003 [P] Create `packages/control-plane/vitest.config.ts` (same pattern as credhelper-daemon)
- [ ] T004 Implement `src/errors.ts` — `ControlPlaneError` class with codes: `INVALID_REQUEST` (400), `NOT_FOUND` (404), `UNKNOWN_ACTION` (400), `SERVICE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500); `sendError()` utility; matches `{ error, code, details? }` shape
- [ ] T005 [P] Implement `src/util/read-body.ts` — request body reading utility (same pattern as credhelper-daemon)

## Phase 2: Schemas, Types & Context

- [ ] T006 Implement `src/schemas.ts` — `ClusterStatusSchema` (enum: bootstrapping/ready/degraded/error), `DeploymentModeSchema` (enum: local/cloud), `ClusterVariantSchema` (enum: cluster-base/cluster-microservices), `ClusterStateSchema`, `LifecycleActionSchema` (enum: clone-peer-repos/code-server-start/code-server-stop), `LifecycleResponseSchema`, `CredentialStubResponseSchema`, `ErrorResponseSchema`; re-export credential/role schemas from `@generacy-ai/credhelper`
- [ ] T007 [P] Implement `src/types.ts` — `ServerConfig` interface (socketPath), `RouteHandler` type signature `(req, res, actor, params) => Promise<void>`
- [ ] T008 [P] Implement `src/context.ts` — `ActorContext` interface (userId?, sessionId?), `extractActorContext(req)` function reading `x-generacy-actor-user-id` and `x-generacy-actor-session-id` headers

## Phase 3: Route Handlers (Stubs)

- [ ] T009 Implement `src/routes/state.ts` — GET handler returning stub: `{ status: 'ready', deploymentMode: 'local', variant: 'cluster-base', lastSeen: <ISO timestamp> }`
- [ ] T010 [P] Implement `src/routes/credentials.ts` — GET returns stub credential with `{ id, type, backend, backendKey, status: 'active', createdAt }`; PUT reads body, returns `{ ok: true }`
- [ ] T011 [P] Implement `src/routes/roles.ts` — GET returns stub role with `{ id, description, credentials: [] }`; PUT reads body, returns `{ ok: true }`
- [ ] T012 [P] Implement `src/routes/lifecycle.ts` — Validates action against `LifecycleActionSchema`, returns `{ accepted: true, action }`; throws `UNKNOWN_ACTION` for invalid actions

## Phase 4: Server & Router

- [ ] T013 Implement `src/router.ts` — URL pattern matching via regex for all 6 routes plus 404 fallback; dispatches to route handlers with extracted `ActorContext` and URL params (`:id`, `:action`); method validation per route
- [ ] T014 Implement `src/server.ts` — `ControlPlaneServer` class with `start(socketPath)` (bind Unix socket, cleanup stale socket, chmod 0660), `close()` (graceful shutdown), error boundary wrapping all requests (unhandled errors -> 500)
- [ ] T015 Implement `src/index.ts` — Public exports: types, schemas, `ControlPlaneServer` class

## Phase 5: Entry Point

- [ ] T016 Implement `bin/control-plane.ts` — Parse `CONTROL_PLANE_SOCKET_PATH` env var (default: `/run/generacy-control-plane/control.sock`), install SIGTERM/SIGINT signal handlers for graceful shutdown, uncaught exception/unhandled rejection -> log + exit(1), start server, log readiness message

## Phase 6: Tests

- [ ] T017 Write `__tests__/errors.test.ts` — Unit tests for `ControlPlaneError` class (all error codes, HTTP status mapping, `toResponse()` shape, `sendError()`)
- [ ] T018 [P] Write `__tests__/context.test.ts` — Unit tests for `extractActorContext()` (both headers present, one missing, both missing)
- [ ] T019 [P] Write `__tests__/router.test.ts` — Route dispatch unit tests (correct handler for each URL pattern, 404 for unknown routes, method validation)
- [ ] T020 [P] Write `__tests__/routes/state.test.ts` — State endpoint returns valid `ClusterState` shape
- [ ] T021 [P] Write `__tests__/routes/credentials.test.ts` — GET returns stub credential, PUT accepts body and returns `{ ok: true }`
- [ ] T022 [P] Write `__tests__/routes/roles.test.ts` — GET returns stub role, PUT accepts body and returns `{ ok: true }`
- [ ] T023 [P] Write `__tests__/routes/lifecycle.test.ts` — Valid action returns `{ accepted, action }`, invalid action returns 400 `UNKNOWN_ACTION`
- [ ] T024 Write `__tests__/integration/all-routes.test.ts` — Boot server on temp Unix socket, HTTP requests to every route, verify response shapes and status codes, verify actor headers parsed, verify 404 for unknown routes, verify 400 for unknown lifecycle actions

## Phase 7: Build Verification & Documentation

- [ ] T025 Run `pnpm build` and `pnpm lint` — verify package compiles and lints clean
- [ ] T026 [P] Run full test suite — verify all unit and integration tests pass
- [ ] T027 [P] Create `packages/control-plane/README.md` — Document socket path, routes, actor headers, error shape, and orchestrator integration notes (how entrypoint spawns service as sub-process)

## Dependencies & Execution Order

**Phase 1** (T001-T005): T001 first (package.json needed for installs), then T002-T005 in parallel.

**Phase 2** (T006-T008): Depends on Phase 1 (errors.ts, read-body.ts). T006 first (schemas needed by types), then T007 and T008 in parallel.

**Phase 3** (T009-T012): Depends on Phase 2 (schemas, types, context, read-body). All four route handlers can run in parallel after T006 + T007 + T008.

**Phase 4** (T013-T015): Depends on Phase 3 (route handlers). T013 first (router), then T014 (server uses router), then T015 (index exports server).

**Phase 5** (T016): Depends on T014 (server class). Standalone.

**Phase 6** (T017-T024): Depends on Phases 1-5 (all source code). T017-T023 can run in parallel (unit tests). T024 (integration) should run last as it exercises the full stack.

**Phase 7** (T025-T027): Depends on Phase 6. T025 first (must compile), then T026 and T027 in parallel.

**Parallel opportunities**: 14 of 27 tasks are marked [P] and can run concurrently within their phase.
