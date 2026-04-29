# Clarifications: Wire scoped docker-socket-proxy into ExposureRenderer

## Batch 1 — 2026-04-29

### Q1: Scratch Volume Path Definition
**Context**: FR-008 requires denying `POST /containers/create` with bind mounts "outside a designated scratch volume" for host-socket upstreams. The scratch volume path is never defined, which blocks implementation of the bind-mount validation logic.
**Question**: What path constitutes the "designated scratch volume"? Is it a fixed path (e.g., `/tmp/generacy-scratch`), configured per-role in the role config YAML, or set via an environment variable on the credhelper daemon?
**Options**:
- A: Fixed well-known path (e.g., `/var/lib/generacy/scratch`)
- B: Configured per-role in the `docker:` block (e.g., `docker.scratchVolume: /path`)
- C: Daemon-level env var (e.g., `GENERACY_SCRATCH_VOLUME`)
- D: Derived from session directory (e.g., `$GENERACY_SESSION_DIR/scratch`)

**Answer**: *Pending*

### Q2: Fail-Closed Scope
**Context**: FR-004 says "fail closed if no upstream socket is available" with "clear error at credhelper boot." However, many roles don't use Docker at all. If the daemon refuses to start when no Docker socket is present, it would block all credential operations even for non-Docker roles.
**Question**: Should "fail closed" apply at daemon startup (blocking all roles if no Docker socket exists), or only when a session is requested for a role that has a `docker:` block?
**Options**:
- A: Fail at daemon boot — no Docker socket means daemon won't start
- B: Fail per-session — daemon starts normally, but `beginSession()` fails for roles with `docker:` blocks when no upstream socket is available
- C: Warn at boot, fail per-session — log a warning at startup if no socket found, then fail closed only when Docker is actually requested

**Answer**: *Pending*

### Q3: Existing Code Delta
**Context**: The codebase already contains `ExposureRenderer.renderDockerSocketProxy()`, SessionManager handling of `docker-socket-proxy` exposures, and `DOCKER_HOST` in the credentials interceptor's `buildSessionEnv()`. The spec describes functionality that appears largely implemented.
**Question**: What is the specific delta this ticket should deliver? Is it primarily (a) adding the upstream selection fallback logic (`ENABLE_DIND` → host-socket → fail), (b) adding bind-mount restriction enforcement for host-socket mode, (c) adding integration/unit tests for the existing wiring, or (d) a combination?
**Options**:
- A: Upstream selection fallback + bind-mount restrictions + tests (all three)
- B: Only bind-mount restriction enforcement and host-socket-specific allowlist logic
- C: Primarily a test/verification ticket — confirm existing wiring works end-to-end
- D: Refactor to move upstream selection out of SessionManager into ExposureRenderer

**Answer**: *Pending*

### Q4: Bind Mount Inspection Depth
**Context**: FR-008 targets `POST /containers/create` for bind-mount validation. However, the Docker API also accepts host config in `POST /containers/{id}/start` (deprecated but functional) and bind mounts can appear in multiple JSON fields (`HostConfig.Binds`, `HostConfig.Mounts`, `Volumes`).
**Question**: Which Docker API endpoints and request body fields should the bind-mount restriction inspect?
**Options**:
- A: Only `POST /containers/create`, inspecting both `HostConfig.Binds` and `HostConfig.Mounts`
- B: Both `/containers/create` and `/containers/{id}/start`, inspecting `Binds` and `Mounts`
- C: Only `POST /containers/create`, inspecting `HostConfig.Binds` only (simpler, covers primary path)

**Answer**: *Pending*

### Q5: ENABLE_DIND Default Behavior
**Context**: The upstream selection logic checks `ENABLE_DIND=true` first. If `ENABLE_DIND` is unset or empty, it's unclear whether the daemon should skip DinD detection entirely (treating unset as `false`) or try both sockets in order.
**Question**: When `ENABLE_DIND` is not set, should the daemon skip `/var/run/docker.sock` and go straight to checking `/var/run/docker-host.sock`, or should it probe both sockets regardless?
**Options**:
- A: Unset = `false` — skip DinD, try only `/var/run/docker-host.sock`
- B: Probe both sockets in order regardless of `ENABLE_DIND` — env var only controls preference priority
- C: Unset = error — require `ENABLE_DIND` to be explicitly set when a role uses Docker

**Answer**: *Pending*
