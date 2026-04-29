# Implementation Plan: Wire scoped docker-socket-proxy into ExposureRenderer

**Feature**: Integrate the existing `DockerProxy` class into the per-session `ExposureRenderer`, completing upstream selection fallback, bind-mount restrictions for host-socket mode, and scratch volume management.
**Branch**: `497-context-credhelper-daemon`
**Status**: Complete

## Summary

The credhelper-daemon already ships a fully functional `DockerProxy` class (from #464) with allowlist matching, container name resolution, and proxy forwarding. The `ExposureRenderer` and `SessionManager` already wire docker-socket-proxy exposures into session lifecycle. This ticket delivers the three remaining pieces:

1. **Upstream selection hardening** — The current `detectUpstreamSocket()` fails at boot with a throw. The spec requires per-session failure (warn at boot, fail per-session) so non-Docker roles continue working.
2. **Bind-mount restriction for host-socket mode** — When `upstreamIsHost=true`, `POST /containers/create` must be intercepted to reject bind mounts pointing outside `GENERACY_SCRATCH_DIR`.
3. **Per-session scratch directory** — Create `/var/lib/generacy/scratch/<session-id>/` at session begin, expose as `GENERACY_SCRATCH_DIR`, clean at session end.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js >= 20
- **Package**: `packages/credhelper-daemon`
- **Test framework**: Vitest
- **Dependencies**: `node:http`, `node:fs/promises`, `picomatch` (already in deps)
- **No new external dependencies required**

## Existing Code Analysis

### Already implemented (not in scope)
- `DockerProxy` class — full lifecycle (start/stop), Unix socket proxy
- `DockerAllowlistMatcher` — regex/glob rule matching
- `DockerProxyHandler` — request forwarding with allowlist checks
- `ContainerNameResolver` — ID-to-name caching
- `ExposureRenderer.renderDockerSocketProxy()` — creates/starts proxy
- `SessionManager.beginSession()` — wires docker proxy creation for `docker-socket-proxy` exposures
- `SessionManager.endSession()` — stops docker proxy
- `buildSessionEnv()` in orchestrator — already sets `DOCKER_HOST`

### Needs modification
- `docker-upstream.ts` — Change boot behavior from throw to warn-only
- `daemon.ts` — Adjust to not fail when no Docker socket found (already done, but verify logging)
- `docker-proxy-handler.ts` — Add bind-mount inspection middleware for host-socket mode
- `session-manager.ts` — Add scratch dir creation/cleanup, pass `GENERACY_SCRATCH_DIR` env
- `exposure-renderer.ts` — Add scratch dir rendering helper
- `types.ts` — Add scratch dir to `SessionState`, add bind-mount config types

### Needs creation
- `src/docker-bind-mount-guard.ts` — Bind-mount validation logic (inspect `HostConfig.Binds` and `HostConfig.Mounts`)
- `__tests__/docker-bind-mount-guard.test.ts` — Unit tests for bind-mount validation
- `__tests__/docker-proxy-handler.test.ts` — Integration tests with fake upstream daemon
- `__tests__/docker-integration.test.ts` — End-to-end integration test

## Project Structure

```
packages/credhelper-daemon/
  src/
    docker-bind-mount-guard.ts        # NEW — bind-mount path validation
    docker-proxy-handler.ts           # MODIFY — wire bind-mount guard for host-socket
    docker-upstream.ts                # VERIFY — already correct per-session behavior
    exposure-renderer.ts              # MODIFY — add scratch dir helper
    session-manager.ts                # MODIFY — scratch dir lifecycle, env injection
    types.ts                          # MODIFY — scratch dir in SessionState
    daemon.ts                         # VERIFY — boot warning behavior
  __tests__/
    docker-bind-mount-guard.test.ts   # NEW — bind-mount validation unit tests
    docker-proxy-integration.test.ts  # NEW — end-to-end with fake daemon
    docker-proxy-handler.test.ts      # NEW — handler unit tests with body interception
    docker-upstream.test.ts           # EXISTS — verify coverage
    docker-allowlist.test.ts          # EXISTS — verify coverage
    exposure-renderer.test.ts         # EXISTS — may need scratch dir test

packages/orchestrator/
  src/launcher/
    credentials-interceptor.ts        # VERIFY — DOCKER_HOST propagation
    __tests__/
      credentials-interceptor.test.ts # VERIFY — add DOCKER_HOST assertion if missing
```

## Constitution Check

No `.specify/memory/constitution.md` found. Proceeding without constitution constraints.

## Implementation Phases

### Phase 1: Scratch Directory Lifecycle
- Add `scratchDir` to `SessionState` type
- Create scratch dir at session begin (`/var/lib/generacy/scratch/<sessionId>/`, mode 0700, uid 1001)
- Set `GENERACY_SCRATCH_DIR` env var in session env
- Clean scratch dir at session end (after Docker proxy stop)

### Phase 2: Bind-Mount Guard
- Create `docker-bind-mount-guard.ts` with `validateBindMounts(body, scratchDir)` function
- Parse `POST /containers/create` request body
- Inspect `HostConfig.Binds` (format: `src:dst[:opts]`) and `HostConfig.Mounts` (array of `{Type, Source, Target}`)
- Reject any bind mount whose resolved source path is not under `scratchDir`
- Return structured error with rejected paths for debugging

### Phase 3: Handler Integration
- Modify `createDockerProxyHandler()` to accept optional `scratchDir` parameter
- When `upstreamIsHost=true` and request is `POST /containers/create`, buffer body and validate bind mounts
- On violation, return 403 with `DOCKER_ACCESS_DENIED` code and descriptive error
- DinD mode skips bind-mount validation entirely (already isolated)

### Phase 4: Wiring
- Update `ExposureRenderer.renderDockerSocketProxy()` to accept `scratchDir`
- Update `SessionManager.beginSession()` to pass scratch dir to proxy handler
- Verify `DOCKER_HOST` propagation in orchestrator credentials-interceptor tests

### Phase 5: Tests
- Unit tests for bind-mount guard (valid paths, rejected paths, edge cases)
- Unit tests for handler with body interception
- Integration test with fake upstream daemon (both DinD and host-socket paths)
- Verify orchestrator `buildSessionEnv()` includes `DOCKER_HOST`

## Key Design Decisions

1. **Scratch dir path**: `/var/lib/generacy/scratch/<session-id>/` — real disk, per-session isolation, cleaned on end
2. **Bind-mount validation scope**: Only `POST /containers/create`, both `Binds` and `Mounts` fields
3. **DinD vs host-socket distinction**: DinD skips bind-mount guard (container daemon is already isolated); host-socket enforces it
4. **Path validation**: Use `path.resolve()` to canonicalize and then `startsWith()` to verify containment (prevents `../` escapes)
5. **Body buffering**: Only buffer for `POST /containers/create` on host-socket — all other requests stream through

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Body buffering adds latency | Only triggered for `POST /containers/create` on host-socket mode |
| Symlink escape in bind mounts | Use `fs.realpath()` for source paths before comparison |
| Large request body DoS | Add 10MB body size limit for create requests |
| Race between scratch dir creation and Docker use | Scratch dir created before proxy starts |
