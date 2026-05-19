# Tasks: Scoped Docker Socket Proxy

**Input**: Design documents from `/specs/464-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Foundation

- [X] T001 Add `picomatch` dependency to `packages/credhelper-daemon/package.json` and add `@types/picomatch` to devDependencies
- [X] T002 [P] [US1] Add docker-proxy error codes (`DOCKER_ACCESS_DENIED`, `DOCKER_UPSTREAM_NOT_FOUND`, `DOCKER_NAME_RESOLUTION_FAILED`) to `packages/credhelper-daemon/src/errors.ts` with HTTP status mappings (403, 503, 403)
- [X] T003 [P] [US1] Add `dockerProxy?: DockerProxy` field to `SessionState` in `packages/credhelper-daemon/src/types.ts`, plus `CompiledDockerRule`, `AllowlistMatchResult`, `DockerProxyConfig`, and `ContainerNameCacheEntry` interfaces

## Phase 2: Core Allowlist Engine

- [X] T010 [US1] Implement `DockerAllowlistMatcher` class in `packages/credhelper-daemon/src/docker-allowlist.ts` — compile `DockerRule[]` to regex patterns, extract `{id}` from path templates, match method+path, integrate `picomatch` for `name` glob matching
- [X] T011 [P] [US2] Implement `detectUpstreamSocket()` in `packages/credhelper-daemon/src/docker-upstream.ts` — priority-ordered check (DinD `/var/run/docker.sock` when `ENABLE_DIND=true`, then DooD `/var/run/docker-host.sock`), fail closed with `DOCKER_UPSTREAM_NOT_FOUND` error

## Phase 3: Tests for Core (TDD)

- [X] T020 [US1] Write unit tests for `DockerAllowlistMatcher` in `packages/credhelper-daemon/__tests__/docker-allowlist.test.ts` — default deny, exact match, `{id}` patterns, glob matching (`firebase-*`), version prefix stripping, rules without `name` field, multiple matching rules
- [X] T021 [P] [US2] Write unit tests for `detectUpstreamSocket()` in `packages/credhelper-daemon/__tests__/docker-upstream.test.ts` — DinD detection, DooD detection, both missing → error

## Phase 4: Container Name Resolution

- [X] T030 [US3] Implement `ContainerNameResolver` class in `packages/credhelper-daemon/src/docker-name-resolver.ts` — resolve container ID → name via `GET /containers/{id}/json` to upstream socket, `Map<string, ContainerNameCacheEntry>` cache, return `null` on failure (caller denies), `clear()` method for session cleanup
- [X] T031 [US3] Write unit tests for `ContainerNameResolver` in `packages/credhelper-daemon/__tests__/docker-name-resolver.test.ts` — successful resolution, cache hit, resolution failure returns null, cache clear

## Phase 5: Request Handler

- [X] T040 [US1] Implement `createDockerProxyHandler()` factory in `packages/credhelper-daemon/src/docker-proxy-handler.ts` — returns `http.RequestListener`; parse incoming request, strip `/v\d+\.\d+` prefix, check `follow=true` on logs endpoint → 403, match against allowlist, resolve container name for `{id}` paths with `name` glob, forward allowed requests via `http.request({ socketPath })` with stream piping, return 403 JSON `{ error, code: "DOCKER_ACCESS_DENIED", details }` for denied requests, log security warning for dangerous paths on host socket
- [X] T041 [US1] Write unit tests for `createDockerProxyHandler()` in `packages/credhelper-daemon/__tests__/docker-proxy-handler.test.ts` — allowed request forwards, denied request returns 403, version prefix stripped, `follow=true` rejected, chunked response relay, dangerous path logged

## Phase 6: Per-Session Proxy Lifecycle

- [X] T050 [US1] Implement `DockerProxy` class in `packages/credhelper-daemon/src/docker-proxy.ts` — `constructor(config: DockerProxyConfig)`, `start()` creates `net.Server` listening on `{sessionDir}/docker.sock` (mode 0660), `stop()` closes server + removes socket file + clears name resolver cache

## Phase 7: Integration with Session Lifecycle

- [X] T060 [US1] Replace `renderDockerSocketProxy()` stub in `packages/credhelper-daemon/src/exposure-renderer.ts` — new implementation creates and starts `DockerProxy`, returns it for session state tracking
- [X] T061 [US1] Modify `beginSession()` in `packages/credhelper-daemon/src/session-manager.ts` to pass `roleConfig.docker.allow` rules to the proxy when exposure is `docker-socket-proxy`, store returned `DockerProxy` in session state, add `DOCKER_HOST` env var to session env
- [X] T062 [US1] Modify `endSession()` in `packages/credhelper-daemon/src/session-manager.ts` to call `dockerProxy.stop()` for cleanup on session end

## Phase 8: Boot-Time Validation

- [X] T070 [US2] Add upstream socket detection at daemon startup in `packages/credhelper-daemon/src/daemon.ts` — call `detectUpstreamSocket()` during `Daemon.start()`, store result, log security warning if upstream is host socket and roles allow `POST /containers/create`

## Phase 9: Integration Tests

- [X] T080 [US1][US2][US3] Write integration test in `packages/credhelper-daemon/__tests__/integration/docker-proxy.test.ts` — full lifecycle: start proxy → send allowed request → verify forwarded → send denied request → verify 403 → container name filtering → stop proxy → verify cleanup. Skip if no Docker socket available.

## Phase 10: Exports & Wiring

- [X] T090 Export new public APIs from `packages/credhelper-daemon/src/index.ts` — `DockerProxy`, `DockerAllowlistMatcher`, `detectUpstreamSocket`, `ContainerNameResolver`

## Dependencies & Execution Order

```
T001 ──────────────────────────────────────────────────┐
T002 [P] ─────────────────────────────────────────────┐│
T003 [P] ─────────────────────────────────────────────┤│
                                                       ▼▼
T010 (needs T001 picomatch, T003 types) ──────┐
T011 [P] (needs T002 error codes) ────────────┤
                                               ▼
T020 (tests T010) ────────────────────────────┐
T021 [P] (tests T011) ───────────────────────┐│
                                              ▼▼
T030 (needs T010 matcher, T011 upstream) ─────┐
T031 (tests T030) ───────────────────────────┐│
                                              ▼▼
T040 (needs T010, T011, T030) ────────────────┐
T041 (tests T040) ───────────────────────────┐│
                                              ▼▼
T050 (needs T040 handler) ────────────────────┐
                                               ▼
T060 (needs T050 DockerProxy) ────────────────┐
T061 (needs T060 renderer) ──────────────────┐│
T062 (needs T061 begin changes) ─────────────┤│
                                              ▼▼
T070 (needs T011 detection fn) ───────────────┐
                                               ▼
T080 (needs all above) ───────────────────────┐
T090 (needs all above) ──────────────────[P]──┘
```

**Parallel opportunities**:
- T001, T002, T003 can all run in parallel (different files)
- T010 and T011 can run in parallel (independent modules)
- T020 and T021 can run in parallel (independent test files)
- T080 and T090 can run in parallel (no shared files)

**Sequential constraints**:
- Phase 1 → Phase 2 (types/deps needed for implementation)
- Each module's tests follow its implementation
- Phase 5 handler depends on Phase 2 matcher + Phase 4 resolver
- Phase 6 proxy depends on Phase 5 handler
- Phase 7 integration depends on Phase 6 proxy class
- Phase 9 integration tests depend on all implementation
