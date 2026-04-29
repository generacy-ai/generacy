# Tasks: Wire scoped docker-socket-proxy into ExposureRenderer

**Input**: Design documents from `/specs/497-context-credhelper-daemon/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Scratch Directory Lifecycle

- [X] T001 Add `scratchDir?: string` to `SessionState` in `packages/credhelper-daemon/src/types.ts`; add `scratchDir?: string` to `DockerProxyConfig`
- [X] T002 [P] Create `packages/credhelper-daemon/src/scratch-directory.ts` — implement `createScratchDir(sessionId, uid?, gid?)` and `removeScratchDir(scratchDir)` per contract (base path `/var/lib/generacy/scratch/`, mode 0700, uid 1001, recursive cleanup)
- [X] T003 [P] Create `packages/credhelper-daemon/__tests__/scratch-directory.test.ts` — unit tests for create (happy path, parent creation, collision error) and remove (success, missing dir no-op, best-effort on failure)

## Phase 2: Bind-Mount Guard

- [X] T004 Create `packages/credhelper-daemon/src/docker-bind-mount-guard.ts` — implement `validateBindMounts(body, scratchDir)` and `bufferRequestBody(req, maxBytes?)` per contract. Parse `HostConfig.Binds` (split on `:`) and `HostConfig.Mounts` (filter `Type === 'bind'`), canonicalize with `path.resolve()`, check `startsWith(scratchDir)`. Include `BindMountViolation`, `BindMountValidationResult`, `DockerMountEntry`, `DockerCreateBody` types
- [X] T005 Create `packages/credhelper-daemon/__tests__/docker-bind-mount-guard.test.ts` — unit tests: valid mounts under scratch, rejected mounts outside scratch, `../` traversal, empty Binds/Mounts, missing HostConfig, mixed valid/invalid, `bufferRequestBody` size limit enforcement

## Phase 3: Handler Integration

- [X] T006 Modify `packages/credhelper-daemon/src/docker-proxy-handler.ts` — accept `scratchDir` in handler options; when `upstreamIsHost=true` and request is `POST /containers/create`, buffer body, run `validateBindMounts()`, return 403 with `DOCKER_ACCESS_DENIED` on violation; DinD mode skips validation. Add 10MB body size limit
- [X] T007 Create `packages/credhelper-daemon/__tests__/docker-proxy-handler.test.ts` — unit tests for handler: host-socket mode blocks invalid bind mounts, allows valid mounts, DinD mode skips guard, non-create requests pass through, body size limit rejection

## Phase 4: Session Manager & Renderer Wiring

- [X] T008 Modify `packages/credhelper-daemon/src/session-manager.ts` — create scratch dir at session begin (before Docker proxy start), set `GENERACY_SCRATCH_DIR` in session env, pass `scratchDir` to proxy config, store `scratchDir` in `SessionState`, clean scratch dir at session end (after Docker proxy stop)
- [X] T009 [P] Modify `packages/credhelper-daemon/src/exposure-renderer.ts` — update `renderDockerSocketProxy()` to accept and forward `scratchDir` to `DockerProxyConfig`
- [X] T010 [P] Verify `packages/credhelper-daemon/src/docker-upstream.ts` — confirm `detectUpstreamSocket()` warns at boot (not throws) when no Docker socket found; non-Docker sessions unaffected. Fix if needed
- [X] T011 [P] Verify `packages/orchestrator/src/launcher/credentials-interceptor.ts` — confirm `DOCKER_HOST` propagation from credhelper response into spawned process env; add assertion in test if missing

## Phase 5: Integration Tests

- [X] T012 Create `packages/credhelper-daemon/__tests__/docker-proxy-integration.test.ts` — end-to-end test with fake upstream daemon: session begin creates scratch dir + proxy socket, allowed Docker API calls succeed, disallowed verbs return 403, bind mount outside scratch rejected (host-socket), bind mount allowed (DinD), session end cleans up proxy + scratch dir
- [X] T013 Verify existing tests pass — run full test suite for `packages/credhelper-daemon` and `packages/orchestrator` to confirm no regressions

## Dependencies & Execution Order

**Sequential constraints**:
- T001 (types) must complete before T004, T006, T008, T009
- T002 (scratch-directory) must complete before T008
- T004 (bind-mount guard) must complete before T006 (handler integration)
- T006 (handler integration) must complete before T008 (session manager wiring)
- T008, T009, T010, T011 (wiring) must complete before T012 (integration tests)
- T012 must complete before T013 (regression check)

**Parallel opportunities**:
- Phase 1: T002 and T003 can run in parallel (different files)
- Phase 2: T004 and T005 can run after T001; T005 can start once T004 is done
- Phase 4: T009, T010, T011 can run in parallel (different packages/files)

**Critical path**: T001 → T004 → T006 → T008 → T012 → T013
