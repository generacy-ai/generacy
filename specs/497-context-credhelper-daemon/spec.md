# Feature Specification: Wire scoped docker-socket-proxy into ExposureRenderer

**Branch**: `497-context-credhelper-daemon` | **Date**: 2026-04-29 | **Status**: Draft
**Issue**: [#497](https://github.com/generacy-ai/generacy/issues/497) | **Release**: v1.5 / phase-9

## Summary

Integrate the existing `DockerProxy` class (shipped in #464) into the credhelper-daemon's `ExposureRenderer` so that roles declaring a `docker:` block get a per-session scoped Docker socket with allowlist-based API filtering. This enables workflows to use Docker commands (e.g., `docker ps`) with fine-grained access control, while preventing unauthorized operations.

## Context

The credhelper-daemon already has a complete `DockerProxy` class (shipped in #464) but it is not yet integrated into the per-session `ExposureRenderer`. v1.5 wires it up so roles with a `docker:` block produce a per-session scoped docker socket and `DOCKER_HOST` env. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) -- "Scoped docker socket proxy".

## Scope

In `packages/credhelper-daemon/src/exposure-renderer.ts`:

- When a session's role contains a `docker:` block, instantiate a per-session `DockerProxy` instance (using the existing class).
- Bind its proxy socket at `$GENERACY_SESSION_DIR/docker.sock`.
- Choose upstream per credentials plan decision #16:
  - If `ENABLE_DIND=true` and `/var/run/docker.sock` is reachable, forward there.
  - Else if `/var/run/docker-host.sock` is mounted, forward there.
  - Else fail closed at credhelper boot with a clear error.
- Set `DOCKER_HOST=unix://$GENERACY_SESSION_DIR/docker.sock` on the session env.
- On session end, tear down the proxy instance cleanly.

In `packages/credhelper-daemon/src/session-manager.ts`:
- Wire the renderer change so the `docker.sock` file appears in the session directory layout.

In the `applyCredentials` interceptor on the orchestrator side (`packages/orchestrator/src/launcher/credentials-interceptor.ts`):
- Confirm `DOCKER_HOST` is propagated from the credhelper response into the spawned process env (already partially wired per #465 -- verify and add a test).

Default allowlists:
- For DinD upstreams, default-deny everything except role-declared verbs.
- For host-socket upstreams, additionally deny `POST /containers/create` with bind mounts pointing outside a designated scratch volume; document this explicitly in the role-validation error message.

## User Stories

### US1: Developer using Docker in a workflow

**As a** workflow author defining a `fullstack-developer` role,
**I want** to declare which Docker API endpoints the role is allowed to call,
**So that** agents running under that role can use Docker commands like `docker ps` without being able to perform unauthorized operations.

**Acceptance Criteria**:
- [ ] A `docker.allow` list in the role config grants access to specific Docker API verbs/paths
- [ ] Disallowed Docker API calls return HTTP 403
- [ ] `DOCKER_HOST` env var is automatically set for the spawned process

### US2: Platform operator securing host Docker access

**As a** platform operator running Generacy with host-mounted Docker sockets,
**I want** stricter default allowlists for host-socket upstreams than for DinD upstreams,
**So that** agents cannot escape the sandbox by creating containers with arbitrary bind mounts.

**Acceptance Criteria**:
- [ ] Host-socket mode additionally denies `POST /containers/create` with bind mounts outside scratch volume
- [ ] DinD mode only enforces role-declared verb allowlists
- [ ] Clear error messages when a request is denied due to allowlist policy

### US3: Session lifecycle cleanup

**As a** credhelper-daemon operator,
**I want** Docker proxy sockets to be torn down when a session ends,
**So that** there are no leaked file descriptors or stale sockets between workflow runs.

**Acceptance Criteria**:
- [ ] Session end closes the per-session proxy listener and removes the socket file
- [ ] No leaked resources after session teardown

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | ExposureRenderer instantiates DockerProxy when role has `docker:` block | P1 | Uses existing DockerProxy class from #464 |
| FR-002 | Proxy socket bound at `$GENERACY_SESSION_DIR/docker.sock` | P1 | Per-session isolation |
| FR-003 | Upstream selection: DinD (`/var/run/docker.sock`) vs host (`/var/run/docker-host.sock`) | P1 | Per credentials plan decision #16 |
| FR-004 | Fail closed if no upstream socket is available | P1 | Clear error at credhelper boot |
| FR-005 | `DOCKER_HOST` env var set on session env | P1 | `unix://$GENERACY_SESSION_DIR/docker.sock` |
| FR-006 | Session teardown cleans up proxy instance and socket | P1 | |
| FR-007 | DinD allowlist: default-deny, only role-declared verbs allowed | P1 | |
| FR-008 | Host-socket allowlist: deny bind mounts outside scratch volume | P1 | Stricter than DinD defaults |
| FR-009 | SessionManager wires docker.sock into session directory layout | P1 | |
| FR-010 | Orchestrator propagates `DOCKER_HOST` from credhelper response to process env | P1 | Verify existing #465 wiring, add test |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Allowed Docker API calls succeed | 100% | Integration test with `GET /containers/json` |
| SC-002 | Disallowed Docker API calls return 403 | 100% | Integration test with unlisted verbs |
| SC-003 | Upstream selection correct per env | Both paths tested | Unit test for DinD and host-socket modes |
| SC-004 | Session teardown releases all resources | No leaked sockets/fds | Integration test verifies cleanup |
| SC-005 | Host-socket bind-mount restriction enforced | Bind mounts outside scratch denied | Test with out-of-bounds mount path |

## Assumptions

- The `DockerProxy` class from #464 is feature-complete and ready for integration
- `GENERACY_SESSION_DIR` is already created by the session manager before exposure rendering
- The credhelper-daemon runs with sufficient permissions to create Unix sockets in the session directory
- `ENABLE_DIND` env var and socket paths follow the conventions established in cluster-base

## Out of Scope

- Modifications to the `DockerProxy` class itself (already shipped in #464)
- Docker registry authentication / image pull credentials
- GPU passthrough or device access policies
- Network policy enforcement beyond the Docker API allowlist
- Runtime monitoring or audit logging of Docker API calls (future phase)

---

*Generated by speckit*
