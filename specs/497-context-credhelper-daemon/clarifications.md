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

**Answer**: D-modified — Per-session scratch directory at `/var/lib/generacy/scratch/<session-id>/` (real disk path, mode 0700 owned by workflow uid 1001). Created at session begin; cleaned at session end. Bind mounts in `POST /containers/create` must point under this path or are rejected. Exposed to the workflow as `GENERACY_SCRATCH_DIR` env var so commands like `docker run -v $GENERACY_SCRATCH_DIR:/data ...` work naturally. Real disk (not tmpfs) so containers can persist across in-session restarts; per-session isolation by default.

### Q2: Fail-Closed Scope
**Context**: FR-004 says "fail closed if no upstream socket is available" with "clear error at credhelper boot." However, many roles don't use Docker at all. If the daemon refuses to start when no Docker socket is present, it would block all credential operations even for non-Docker roles.
**Question**: Should "fail closed" apply at daemon startup (blocking all roles if no Docker socket exists), or only when a session is requested for a role that has a `docker:` block?
**Options**:
- A: Fail at daemon boot — no Docker socket means daemon won't start
- B: Fail per-session — daemon starts normally, but `beginSession()` fails for roles with `docker:` blocks when no upstream socket is available
- C: Warn at boot, fail per-session — log a warning at startup if no socket found, then fail closed only when Docker is actually requested

**Answer**: C — Warn at boot, fail per-session. At daemon boot, log a clear warning if no Docker socket is detected. At `beginSession()`, if the role has a `docker:` block, verify upstream socket reachability and fail closed with a clear error if absent. Non-Docker roles continue to work unaffected.

### Q3: Existing Code Delta
**Context**: The codebase already contains `ExposureRenderer.renderDockerSocketProxy()`, SessionManager handling of `docker-socket-proxy` exposures, and `DOCKER_HOST` in the credentials interceptor's `buildSessionEnv()`. The spec describes functionality that appears largely implemented.
**Question**: What is the specific delta this ticket should deliver? Is it primarily (a) adding the upstream selection fallback logic (`ENABLE_DIND` → host-socket → fail), (b) adding bind-mount restriction enforcement for host-socket mode, (c) adding integration/unit tests for the existing wiring, or (d) a combination?
**Options**:
- A: Upstream selection fallback + bind-mount restrictions + tests (all three)
- B: Only bind-mount restriction enforcement and host-socket-specific allowlist logic
- C: Primarily a test/verification ticket — confirm existing wiring works end-to-end
- D: Refactor to move upstream selection out of SessionManager into ExposureRenderer

**Answer**: A — Upstream selection fallback + bind-mount restrictions + tests (all three). The DockerProxy class exists but the integration into `ExposureRenderer.renderDockerSocketProxy()` is partial. This issue completes (1) upstream selection with fallback (`ENABLE_DIND` → `/var/run/docker.sock` → `/var/run/docker-host.sock` → fail per-session); (2) bind-mount restrictions on the host-socket path specifically (DinD doesn't need them — the in-container daemon is already isolated); (3) integration tests against fake daemons covering both upstream paths.

### Q4: Bind Mount Inspection Depth
**Context**: FR-008 targets `POST /containers/create` for bind-mount validation. However, the Docker API also accepts host config in `POST /containers/{id}/start` (deprecated but functional) and bind mounts can appear in multiple JSON fields (`HostConfig.Binds`, `HostConfig.Mounts`, `Volumes`).
**Question**: Which Docker API endpoints and request body fields should the bind-mount restriction inspect?
**Options**:
- A: Only `POST /containers/create`, inspecting both `HostConfig.Binds` and `HostConfig.Mounts`
- B: Both `/containers/create` and `/containers/{id}/start`, inspecting `Binds` and `Mounts`
- C: Only `POST /containers/create`, inspecting `HostConfig.Binds` only (simpler, covers primary path)

**Answer**: A — Only `POST /containers/create`, inspecting both `HostConfig.Binds` and `HostConfig.Mounts`. Modern Docker clients use `POST /containers/create` for mounts. The deprecated `/containers/{id}/start` host config path is rarely seen in contemporary tooling. Both `Binds` and `Mounts` fields are inspected since clients use whichever based on API version.

### Q5: ENABLE_DIND Default Behavior
**Context**: The upstream selection logic checks `ENABLE_DIND=true` first. If `ENABLE_DIND` is unset or empty, it's unclear whether the daemon should skip DinD detection entirely (treating unset as `false`) or try both sockets in order.
**Question**: When `ENABLE_DIND` is not set, should the daemon skip `/var/run/docker.sock` and go straight to checking `/var/run/docker-host.sock`, or should it probe both sockets regardless?
**Options**:
- A: Unset = `false` — skip DinD, try only `/var/run/docker-host.sock`
- B: Probe both sockets in order regardless of `ENABLE_DIND` — env var only controls preference priority
- C: Unset = error — require `ENABLE_DIND` to be explicitly set when a role uses Docker

**Answer**: A — Unset = `false`; skip DinD, try only `/var/run/docker-host.sock`. Matches the cluster-base variant's default (non-DinD). When `ENABLE_DIND=true`, prefer the in-container DinD socket; otherwise go straight to the host socket.
