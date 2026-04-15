# Tasks: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

**Input**: Design documents from `/specs/482-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Prerequisite

> **Blocks on #481 (Phase 7a)** merging first. Phase 7a provides `BackendClientFactory`, `EnvBackend`, and the `GeneracyCloudBackend` stub. Rebase this branch after #481 merges before starting implementation.

## Phase 1: Setup & Error Codes

- [ ] T001 Add `jose` dependency — `pnpm add jose --filter @generacy-ai/credhelper-daemon` (`packages/credhelper-daemon/package.json`)
- [ ] T002 [P] [US1] Add auth-related error codes to `packages/credhelper-daemon/src/errors.ts` — add `INVALID_TOKEN`, `EXPIRED_TOKEN`, `INVALID_SCOPE`, `MALFORMED_REQUEST`, `BACKEND_AUTH_REQUIRED`, `BACKEND_AUTH_EXPIRED` to `ErrorCode` union and HTTP status map (all 400 except BACKEND_AUTH_REQUIRED/EXPIRED → 502)

## Phase 2: Auth Foundation

- [ ] T003 [US1] Create `JwtParser` class at `packages/credhelper-daemon/src/auth/jwt-parser.ts` — export `SessionTokenClaims` interface (`sub`, `org_id`, `scope`, `iat`, `exp`) and `JwtParser` class with `parse(token): SessionTokenClaims`. Use `jose.decodeJwt()` for structural parsing (no signature check). Validate: `sub` present, `org_id` present, `scope === "credhelper"`, `exp` not in past, `iat` present. Throw `CredhelperError` with codes `INVALID_TOKEN`, `EXPIRED_TOKEN`, `INVALID_SCOPE`.
- [ ] T004 [P] [US1] Write `JwtParser` unit tests at `packages/credhelper-daemon/__tests__/auth/jwt-parser.test.ts` — cover: valid token with correct claims, expired token, wrong scope, missing `sub`, missing `org_id`, missing `exp`, missing `iat`, malformed JWT string (not 3 segments), empty string.
- [ ] T005 [US1] Create `SessionTokenStore` class at `packages/credhelper-daemon/src/auth/session-token-store.ts` — export `SessionTokenProvider` interface (`getToken(): Promise<{value, claims} | null>`), `SessionTokenStatus` type, and `SessionTokenStore` class. Constructor takes `tokenFilePath` and `JwtParser`. Methods: `setToken(token)` (parse → atomic write .tmp+rename mode 0600 → update cache), `clearToken()` (unlink ignoring ENOENT → clear cache), `getStatus()` (return claims without token from cache), `getToken()` (return `{value, claims}` or null), `loadFromDisk()` (read file → parse → populate cache, ignore if missing/invalid).
- [ ] T006 [P] [US1] Write `SessionTokenStore` unit tests at `packages/credhelper-daemon/__tests__/auth/session-token-store.test.ts` — cover: `setToken()` writes file atomically with mode 0600, `setToken()` rejects invalid JWT (delegates to JwtParser), `clearToken()` removes file and cache, `clearToken()` is idempotent (ENOENT), `getStatus()` returns authenticated state without token, `getStatus()` returns `{authenticated: false}` when empty, `getToken()` returns value+claims, `loadFromDisk()` restores token from file, `loadFromDisk()` gracefully handles missing file. Use temp directory for token file path.

## Phase 3: Control Server Endpoints

- [ ] T007 [US1] Add three auth routes to `packages/credhelper-daemon/src/control-server.ts` — extend `ControlServer` constructor to accept `SessionTokenStore`. Add route matching for `PUT /auth/session-token` (parse JSON body → `store.setToken()` → 204; catch `CredhelperError` → 400 with error code), `DELETE /auth/session-token` (call `store.clearToken()` → 204), `GET /auth/session-token/status` (call `store.getStatus()` → 200 with status JSON). Integrate into existing request handler alongside `/sessions` routes.
- [ ] T008 [P] [US1] Write control server auth endpoint tests at `packages/credhelper-daemon/__tests__/control-server.test.ts` — add test groups for: PUT success (204, no body), PUT with invalid JWT (400 INVALID_TOKEN), PUT with expired JWT (400 EXPIRED_TOKEN), PUT with wrong scope (400 INVALID_SCOPE), PUT with malformed body / missing token field (400 MALFORMED_REQUEST), DELETE success (204), DELETE when no token stored (204, idempotent), GET when authenticated (200 with user/org/expiresAt, no token), GET when not authenticated (200 `{authenticated: false}`). Follow existing test patterns: mock SessionManager, real ControlServer with mock SessionTokenStore.

## Phase 4: Generacy-Cloud Backend

- [ ] T009 [US1] Replace `GeneracyCloudBackend` stub at `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts` — constructor takes `apiUrl: string` and `sessionTokenProvider: SessionTokenProvider`. `fetchSecret(key)`: call `getToken()`, throw `BackendAuthRequiredError` if null (with message "run `stack secrets login` inside the worker container"), POST to `${apiUrl}/api/organizations/${claims.org_id}/credentials/${encodeURIComponent(key)}/resolve` with `Authorization: Bearer ${token.value}`, map responses: 200 → return `body.value`, 401 → `BackendAuthExpiredError`, 404 → `BackendSecretNotFoundError`, other → `BackendError`.
- [ ] T010 [P] [US1] Update `BackendClientFactory` at `packages/credhelper-daemon/src/backends/factory.ts` — add `apiUrl?: string` and `sessionTokenStore: SessionTokenStore` to factory constructor. Update `generacy-cloud` case: if `!apiUrl` throw `CredhelperError('BACKEND_UNREACHABLE', ...)`, else return `new GeneracyCloudBackend(apiUrl, sessionTokenStore)`.
- [ ] T011 [P] [US1] Write `GeneracyCloudBackend` unit tests at `packages/credhelper-daemon/__tests__/backends/generacy-cloud-backend.test.ts` — replace stub tests. Cover: successful fetch (200, returns value), auth required (no token → `BackendAuthRequiredError`), auth expired (cloud returns 401 → `BackendAuthExpiredError`), not found (cloud returns 404 → `BackendSecretNotFoundError`), server error (cloud returns 500 → `BackendError`), correct URL construction with `encodeURIComponent(key)`, correct Authorization header. Mock `SessionTokenProvider` and `fetch`.

## Phase 5: Wiring & Entry Point

- [ ] T012 [US1] Add `sessionTokenStore` and `generacyCloudApiUrl` to `DaemonConfig` in `packages/credhelper-daemon/src/types.ts` — `sessionTokenStore: SessionTokenStore` (required), `generacyCloudApiUrl?: string` (optional, from env var)
- [ ] T013 [US1] Wire `SessionTokenStore` in `packages/credhelper-daemon/src/daemon.ts` — pass `config.sessionTokenStore` to `ControlServer` constructor (new 4th param). Pass `config.generacyCloudApiUrl` and `config.sessionTokenStore` when creating `BackendClientFactory` (or wherever the factory is instantiated). Call `sessionTokenStore.loadFromDisk()` during `start()` before creating the control server.
- [ ] T014 [US1] Update entry point `packages/credhelper-daemon/bin/credhelper-daemon.ts` — read `GENERACY_CLOUD_API_URL` env var. Define token file path as `${controlSocketDir}/session-token` (where `controlSocketDir` is the directory containing the control socket, i.e., `/run/generacy-credhelper/`). Create `JwtParser` instance and `SessionTokenStore(tokenFilePath, parser)`. Add both to `DaemonConfig`.

## Phase 6: Integration Test

- [ ] T015 [US1] Write integration test at `packages/credhelper-daemon/__tests__/integration/session-token-flow.test.ts` — full login → status → fetch → logout → status cycle. Start daemon with mock config (temp socket, temp sessions dir). Steps: (1) GET status → `{authenticated: false}`, (2) PUT session token with a valid JWT structure → 204, (3) GET status → `{authenticated: true, user, org, expiresAt}`, (4) begin session with role using generacy-cloud backend → verify HTTP call to mock cloud API with correct Bearer auth + correct URL, (5) DELETE session token → 204, (6) GET status → `{authenticated: false}`. Mock the generacy-cloud HTTP endpoint (intercept fetch or use MSW/nock). Verify token file created/deleted on disk with correct permissions.

## Dependencies & Execution Order

```
T001 ──┐
       ├── T003 ── T005 ── T007 ── T012 ── T013 ── T014 ── T015
T002 ──┘     │        │       │                │
             T004     T006   T008    T009 ──┐  │
                                     T010 ──┤  │
                                     T011 ──┘  │
                                               │
                              (all merge) ─────┘
```

**Phase 1** (T001, T002): Parallel — no dependencies between jose install and error codes.

**Phase 2** (T003–T006): T003 first (JwtParser), then T005 (SessionTokenStore depends on JwtParser). T004 and T006 are test tasks that can run in parallel with their respective next-phase tasks.

**Phase 3** (T007, T008): T007 depends on T005 (needs SessionTokenStore). T008 (tests) can run in parallel with Phase 4.

**Phase 4** (T009–T011): T009 (backend implementation) depends on T005 (needs SessionTokenProvider). T010 (factory update) and T011 (backend tests) are parallel with each other and with T009.

**Phase 5** (T012–T014): Sequential — T012 (types) → T013 (daemon wiring) → T014 (entry point). Depends on all Phase 3–4 work.

**Phase 6** (T015): Integration test — depends on everything above.

**Parallel opportunities**: 6 tasks marked `[P]` across phases. Within Phase 4, all three tasks (T009, T010, T011) touch different files and can proceed concurrently.
