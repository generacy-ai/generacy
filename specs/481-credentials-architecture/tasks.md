# Tasks: BackendClient Factory (Phase 7a)

**Input**: Design documents from `/specs/481-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Error Code & Type Foundations

- [X] T001 [P] Add `BACKEND_SECRET_NOT_FOUND` error code to `packages/credhelper-daemon/src/errors.ts` — add to `ErrorCode` union and map to HTTP 502 in `HTTP_STATUS_MAP`
- [X] T002 [P] Create `packages/credhelper-daemon/src/backends/types.ts` — define `BackendClientFactory` interface with `create(backend: BackendEntry): BackendClient` method

## Phase 2: Backend Implementations

- [X] T003 [P] Implement `EnvBackend` in `packages/credhelper-daemon/src/backends/env-backend.ts` — reads `process.env[key]`, throws `BACKEND_SECRET_NOT_FOUND` if undefined, returns empty string if value is `''`
- [X] T004 [P] Implement `GeneracyCloudBackend` stub in `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts` — throws `CredhelperError('NOT_IMPLEMENTED', ...)` on every `fetchSecret()` call with Phase 7b guidance message
- [X] T005 Implement `BackendClientFactory` in `packages/credhelper-daemon/src/backends/factory.ts` — switch dispatch: `'env'` → `EnvBackend`, `'generacy-cloud'` → `GeneracyCloudBackend`, unknown → throws `BACKEND_UNREACHABLE` listing supported types
- [X] T006 Create barrel export `packages/credhelper-daemon/src/backends/index.ts` — re-export factory class and types

## Phase 3: Wiring

- [X] T007 Add `backendFactory: BackendClientFactory` to `DaemonConfig` in `packages/credhelper-daemon/src/types.ts` — import from `./backends/types.js`
- [X] T008 Update `Daemon.start()` in `packages/credhelper-daemon/src/daemon.ts` — pass `this.config.backendFactory` as new constructor arg to `SessionManager`
- [X] T009 Wire factory into `SessionManager` in `packages/credhelper-daemon/src/session-manager.ts` — add `backendFactory: BackendClientFactory` constructor parameter, replace all 4 `{ fetchSecret: async () => '' }` stubs (lines ~91, ~115, ~131, ~146) with `this.backendFactory.create(backend)`. Move `loadBackend()` call above the mint/resolve branch so both paths have access.
- [X] T010 Wire factory in entry point `packages/credhelper-daemon/bin/credhelper-daemon.ts` — import and instantiate `BackendClientFactory`, add `backendFactory` to the `DaemonConfig` object

## Phase 4: Unit Tests

- [X] T011 [P] Create `packages/credhelper-daemon/__tests__/backends/env-backend.test.ts` — test: key exists returns value, key missing throws `BACKEND_SECRET_NOT_FOUND`, empty string returns `''`, whitespace value returns as-is
- [X] T012 [P] Create `packages/credhelper-daemon/__tests__/backends/generacy-cloud-backend.test.ts` — test: any key throws `NOT_IMPLEMENTED` with clear message
- [X] T013 [P] Create `packages/credhelper-daemon/__tests__/backends/factory.test.ts` — test: `type:'env'` returns EnvBackend, `type:'generacy-cloud'` returns GeneracyCloudBackend, unknown type throws `BACKEND_UNREACHABLE` with supported types list

## Phase 5: Existing Test Updates

- [X] T014 [P] Add `createMockBackendFactory()` helper to `packages/credhelper-daemon/__tests__/mocks/mock-config-loader.ts` — returns a mock factory whose `create()` returns a mock `BackendClient`
- [X] T015 [P] Update `packages/credhelper-daemon/__tests__/session-manager.test.ts` — update `createSessionManager()` helper and all `new SessionManager(...)` calls to inject mock `BackendClientFactory`
- [X] T016 [P] Update `packages/credhelper-daemon/__tests__/integration/session-lifecycle.test.ts` — inject mock factory into `SessionManager` constructor

## Phase 6: Integration Test

- [X] T017 Create `packages/credhelper-daemon/__tests__/integration/env-backend-session.test.ts` — end-to-end test: set `process.env.TEST_SECRET`, configure mock role→credential→backend (`type:'env'`, `backendKey:'TEST_SECRET'`), create SessionManager with real `BackendClientFactory`, begin session, verify credential resolves to `'my-secret-value'`, clean up env var in afterEach

## Dependencies & Execution Order

```
Phase 1: T001, T002 — parallel, no dependencies
Phase 2: T003, T004 depend on T001+T002; T005 depends on T003+T004; T006 depends on T005
Phase 3: T007→T008→T009→T010 — sequential (each builds on prior wiring)
Phase 4: T011, T012, T013 — parallel, depend on Phase 2 completion
Phase 5: T014, T015, T016 — parallel, depend on Phase 3 completion
Phase 6: T017 — depends on Phase 3 + Phase 4 completion
```

**Parallel opportunities**:
- T001 + T002 (Phase 1)
- T003 + T004 (Phase 2)
- T011 + T012 + T013 (Phase 4)
- T014 + T015 + T016 (Phase 5)
