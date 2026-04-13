# Tasks: Credhelper Daemon with Session Lifecycle and Unix Socket API

**Input**: Design documents from `/specs/461-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Package Scaffold & Core Infrastructure

- [ ] T001 Create `packages/credhelper-daemon/` with `package.json`, `tsconfig.json`, `vitest.config.ts`
- [ ] T002 [P] Create `src/types.ts` — internal daemon types: `DaemonConfig`, `SessionState`, `CredentialCacheEntry`, `PeerCredentials`, `ConfigLoader`, `PluginRegistry` adapter interfaces
- [ ] T003 [P] Create `src/errors.ts` — `CredhelperError` class with `code: ErrorCode`, `details`, `toResponse(): CredhelperErrorResponse`; `ErrorCode` type union; `sendError()` HTTP response helper
- [ ] T004 [P] Create `src/util/parse-ttl.ts` — parse duration strings (`"1h"`, `"30m"`, `"2d"`) to milliseconds
- [ ] T005 [P] Create `src/util/fs.ts` — async wrappers for `mkdir`, `chmod`, `chown`, `rm -rf` with proper error handling
- [ ] T006 [P] Create `src/peer-cred.ts` — `extractPeerCredentials(socket)` using `socket._handle.fd` + `getsockopt(SOL_SOCKET, SO_PEERCRED)`; `verifyPeer(socket, expectedUid)` function; DAC-only fallback with warning log when SO_PEERCRED unavailable

## Phase 2: Tests — Core Infrastructure

- [ ] T007 [P] Create `__tests__/errors.test.ts` — test `CredhelperError` construction, `toResponse()` formatting, HTTP status mapping for each error code
- [ ] T008 [P] Create `__tests__/peer-cred.test.ts` — test peer credential extraction (mock socket), UID verification pass/fail, DAC fallback path
- [ ] T009 [P] Create `__tests__/mocks/mock-plugin.ts` — `CredentialTypePlugin` stub with configurable `mint()` and `resolve()` behavior (success, failure, delay)
- [ ] T010 [P] Create `__tests__/mocks/mock-config-loader.ts` — `ConfigLoader` stub returning fixture role/credential/backend data

## Phase 3: Credential Store & Token Refresh

- [ ] T011 Create `src/credential-store.ts` — `CredentialStore` class: `set(sessionId, credId, entry)`, `get(sessionId, credId)`, `clearSession(sessionId)`, `isExpired(sessionId, credId)`, `getAllForSession(sessionId)`
- [ ] T012 Create `src/token-refresher.ts` — `TokenRefresher` class: `scheduleRefresh(sessionId, credId, ttlMs, mintFn)` using `setTimeout` at 75% TTL; calls `mint()` and updates store on fire; marks credential unavailable on mint failure; `cancelSession(sessionId)` to clear all timers for a session; `cancelAll()` for shutdown

## Phase 4: Tests — Credential Store & Token Refresh

- [ ] T013 [P] Create `__tests__/credential-store.test.ts` — test set/get/clear/isExpired, multi-session isolation, clearing nonexistent session
- [ ] T014 [P] Create `__tests__/token-refresher.test.ts` — test refresh fires at 75% TTL (fake timers), store updated on success, credential marked unavailable on mint failure, cancel clears timers

## Phase 5: Exposure Rendering

- [ ] T015 Create `src/exposure-renderer.ts` — `ExposureRenderer` class:
  - `renderEnv(sessionDir, entries: {key, value}[])` → writes `env` file with `KEY=VALUE\n` lines, mode 0640
  - `renderGitCredentialHelper(sessionDir, dataSocketPath)` → writes `git/config` + `git/credential-helper` script (curl --unix-socket), mode 0750 for script
  - `renderGcloudExternalAccount(sessionDir, dataSocketPath, credentialId)` → writes `gcp/external-account.json` with `credential_source.url` pointing at data socket
  - `renderSessionDir(sessionDir)` → creates directory tree with correct modes (0750)
  - Phase 3 stubs: `localhost-proxy` and `docker-socket-proxy` → throw `CredhelperError` with `NOT_IMPLEMENTED`

## Phase 6: Tests — Exposure Rendering

- [ ] T016 Create `__tests__/exposure-renderer.test.ts` — test env file content/mode, git config + credential-helper script content/mode, gcloud JSON structure, session directory creation, NOT_IMPLEMENTED error for deferred exposure types

## Phase 7: Session Manager

- [ ] T017 Create `src/session-manager.ts` — `SessionManager` class:
  - Constructor takes `ConfigLoader`, `PluginRegistry`, `CredentialStore`, `TokenRefresher`, `ExposureRenderer`, config
  - `beginSession(req: BeginSessionRequest)` → validate role via config loader → resolve/mint each credential → render exposure files → start data server → store session state → schedule token refresh → return `BeginSessionResponse`
  - `endSession(sessionId)` → cancel refresh timers → close data server → clear credential store → wipe session directory → remove from active sessions
  - `endAll()` → end all active sessions (for shutdown)
  - `getSession(sessionId)` → return session state or throw `SESSION_NOT_FOUND`
  - Expiry sweeper: `setInterval` every `sweepIntervalMs` to check/clean expired sessions with warning log

## Phase 8: Tests — Session Manager

- [ ] T018 Create `__tests__/session-manager.test.ts` — test begin session (role validation, credential resolution, directory creation, data socket binding), end session (cleanup verified), duplicate session ID rejection, invalid role error, unsupported exposure error, expiry sweeper auto-cleanup

## Phase 9: HTTP Servers

- [ ] T019 Create `src/control-server.ts` — `ControlServer` class:
  - `http.createServer` bound to `controlSocketPath`
  - `POST /sessions` → parse JSON body, call `sessionManager.beginSession()`, return `{ session_dir, expires_at }`
  - `DELETE /sessions/:id` → call `sessionManager.endSession()`, return `{ ok: true }`
  - SO_PEERCRED check on `connection` event via `peer-cred.ts`
  - JSON body parsing (manual `req.on('data')` accumulation)
  - Error responses in `CredhelperErrorResponse` format with HTTP status codes
  - `start()` and `close()` methods

- [ ] T020 Create `src/data-server.ts` — `createDataServer(sessionId, store, socketPath)` factory:
  - `http.createServer` bound to per-session socket path
  - `GET /credential/:credentialId` → look up in credential store, return `{ value }` or error
  - 404 for unknown credentials, 410 for expired credentials
  - Returns the `http.Server` instance for lifecycle management

## Phase 10: Tests — HTTP Servers

- [ ] T021 [P] Create `__tests__/control-server.test.ts` — test POST /sessions routing, DELETE /sessions/:id routing, JSON parsing, error responses (400, 404), SO_PEERCRED rejection, unknown routes return 404
- [ ] T022 [P] Create `__tests__/data-server.test.ts` — test GET /credential/:id returns value, 404 for unknown credential, 410 for expired credential, unknown routes return 404

## Phase 11: Daemon Orchestration & CLI

- [ ] T023 Create `src/daemon.ts` — `Daemon` class:
  - Constructor takes `DaemonConfig`
  - `start()`: create credential store → create token refresher → create exposure renderer → create session manager → create control server → bind control socket → start sweeper → log ready
  - `stop()`: stop control server → end all sessions → cancel all timers → log shutdown
  - SIGTERM handler calls `stop()` then `process.exit(0)`
  - Fail-closed: any initialization error → log and exit non-zero

- [ ] T024 Create `src/index.ts` — export `Daemon`, `DaemonConfig`, and key types
- [ ] T025 Create `bin/credhelper-daemon.ts` — CLI entry: parse env vars (`CREDHELPER_CONTROL_SOCKET`, `CREDHELPER_SESSIONS_DIR`, `CREDHELPER_WORKER_UID`, `CREDHELPER_WORKER_GID`) for config, instantiate Daemon, call `start()`, handle uncaught exceptions

## Phase 12: Integration Test

- [ ] T026 Create `__tests__/integration/session-lifecycle.test.ts` — end-to-end with real Unix sockets:
  1. Start daemon with mock config loader + mock plugin
  2. POST /sessions via HTTP client over Unix socket → verify session directory created with correct structure
  3. GET /credential/:id via data socket → verify credential returned
  4. Wait for token refresh (fake timers) → verify updated value
  5. DELETE /sessions/:id → verify session directory wiped, data socket closed
  6. Verify credential store is empty after cleanup

---

## Dependencies & Execution Order

**Sequential phase boundaries** (each phase depends on the previous):
- Phase 1 (scaffold) → Phase 2 (infra tests) → Phase 3 (store/refresh) → Phase 4 (store tests) → Phase 5 (exposure) → Phase 6 (exposure tests) → Phase 7 (session manager) → Phase 8 (session tests) → Phase 9 (HTTP servers) → Phase 10 (server tests) → Phase 11 (daemon) → Phase 12 (integration)

**Parallel opportunities within phases**:
- Phase 1: T002–T006 are all independent files, can run in parallel after T001
- Phase 2: T007–T010 are all independent test files, fully parallel
- Phase 3: T011 before T012 (refresher depends on store)
- Phase 4: T013 and T014 are independent, fully parallel
- Phase 9: T019 and T020 are mostly independent (both use session manager, but don't share files)
- Phase 10: T021 and T022 are independent test files, fully parallel

**Cross-phase dependencies**:
- T011 (credential store) → T012 (token refresher uses store)
- T012 (token refresher) + T015 (exposure renderer) → T017 (session manager uses both)
- T017 (session manager) → T019 (control server delegates to session manager)
- T017 (session manager) + T020 (data server) → T017 also creates data servers during `beginSession`
- T019 + T020 + T023 → T026 (integration test requires all components)
