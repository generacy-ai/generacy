# Tasks: localhost-proxy Exposure Listener

**Input**: Design documents from `/specs/498-context-localhost-proxy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types, Schemas & Error Codes

- [X] T001 [P] [US1] Add `PROXY_PORT_COLLISION`, `PROXY_CONFIG_MISSING`, `PROXY_ACCESS_DENIED` error codes and HTTP status mappings in `packages/credhelper-daemon/src/errors.ts`
- [X] T002 [P] [US2] Add `LocalhostProxyHandle` interface and `localhostProxies?: LocalhostProxyHandle[]` to `SessionState` in `packages/credhelper-daemon/src/types.ts`
- [X] T003 [P] [US1] Add `envName: z.string().optional()` to `RoleExposeSchema` in `packages/credhelper/src/schemas/roles.ts`

## Phase 2: Core Proxy Implementation

- [X] T010 [US1] Create `LocalhostProxy` class in `packages/credhelper-daemon/src/exposure/localhost-proxy.ts` — constructor accepts `LocalhostProxyConfig`, `start()` binds `127.0.0.1:<port>` (fail on EADDRINUSE with `PROXY_PORT_COLLISION`), `stop()` closes server
- [X] T011 [US1] Implement `matchAllowlist(method, path, rules)` pure function in `packages/credhelper-daemon/src/exposure/localhost-proxy.ts` — method exact-match (case-insensitive uppercase), segment-based path matching with `{param}` placeholders, query string stripping, trailing slash significance, case-sensitive paths
- [X] T012 [US1] Implement request handler in `LocalhostProxy` — on match: forward to upstream with auth headers injected via `node:http`/`node:https`, pipe request body and response; on no-match: 403 JSON `{ error, code: 'PROXY_ACCESS_DENIED', details: { method, path } }`

## Phase 3: Wiring (ExposureRenderer + SessionManager)

- [X] T020 [US1] Modify `renderLocalhostProxy` in `packages/credhelper-daemon/src/exposure-renderer.ts` — accept proxy config (allowlist rules, port, upstream, auth headers), create `LocalhostProxy` instance, call `.start()`, return `LocalhostProxyHandle`; write env var for proxy URL
- [X] T021 [US2] Modify `beginSession()` in `packages/credhelper-daemon/src/session-manager.ts` — validate `proxy:<credRef.ref>` exists for each `localhost-proxy` exposure (fail with `PROXY_CONFIG_MISSING` naming missing key); pass proxy config to renderer; collect `LocalhostProxyHandle` into `SessionState.localhostProxies`; write session env var (`envName` or `<REF_UPPER>_PROXY_URL` fallback)
- [X] T022 [US2] Modify `endSession()` in `packages/credhelper-daemon/src/session-manager.ts` — stop all localhost proxy handles before data server close

## Phase 4: Unit Tests

- [ ] T030 [P] [US1] Unit tests for `matchAllowlist` in `packages/credhelper-daemon/__tests__/exposure/localhost-proxy.test.ts` — literal paths, `{param}` placeholders, trailing slash significance, query string stripping, case sensitivity, method matching
- [ ] T031 [P] [US1] Unit tests for proxy handler in `packages/credhelper-daemon/__tests__/exposure/localhost-proxy.test.ts` — allowed request forwards correctly with auth headers, denied request returns 403 JSON, upstream error pass-through
- [ ] T032 [P] [US2] Unit tests for port collision in `packages/credhelper-daemon/__tests__/exposure/localhost-proxy.test.ts` — EADDRINUSE surfaces `PROXY_PORT_COLLISION` error; verify secret not logged

## Phase 5: Integration Tests

- [ ] T040 [US1] Integration test: happy path in `packages/credhelper-daemon/__tests__/integration/localhost-proxy.test.ts` — start session with SendGrid-style role, POST to proxy, verify upstream receives auth header, verify response forwarded
- [ ] T041 [US1] Integration test: default deny in `packages/credhelper-daemon/__tests__/integration/localhost-proxy.test.ts` — GET to POST-only path returns 403; arbitrary path returns 403
- [ ] T042 [US2] Integration test: teardown in `packages/credhelper-daemon/__tests__/integration/localhost-proxy.test.ts` — end session, verify port released (can rebind)
- [ ] T043 [US1] Integration test: validation in `packages/credhelper-daemon/__tests__/integration/localhost-proxy.test.ts` — missing `proxy:` entry fails session creation with `PROXY_CONFIG_MISSING`
- [ ] T044 [US1] Integration test: env var in `packages/credhelper-daemon/__tests__/integration/localhost-proxy.test.ts` — verify session env file contains proxy URL with correct `envName`

## Dependencies & Execution Order

**Phase 1** (all parallel): T001, T002, T003 can all run concurrently — they touch different files with no dependencies.

**Phase 2** (sequential within, depends on Phase 1): T010 depends on T001 (error codes) and T002 (handle type). T011 has no code dependencies but lives in the same file as T010. T012 depends on T010 and T011.

**Phase 3** (sequential, depends on Phase 2): T020 depends on T010 (proxy class). T021 depends on T020 (renderer) and T001 (error codes). T022 depends on T002 (handle type in SessionState).

**Phase 4** (parallel within, depends on Phase 2): T030, T031, T032 can run in parallel — they test different aspects of the same module.

**Phase 5** (sequential within, depends on Phase 3): T040-T044 all depend on the full wiring being complete. They can be written in a single test file but should be run after Phase 3.

**Parallel summary**: 3 parallel groups identified — Phase 1 (3 tasks), Phase 4 (3 tasks), and within Phase 5 integration tests share a file but test independent behaviors.
