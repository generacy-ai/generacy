# Feature Specification: Scoped Docker Socket Proxy (#464)

**Branch**: `464-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

Implement a scoped docker socket proxy inside `packages/credhelper/` that mediates all Docker API access from workflow processes, enforcing per-role method+path allowlists with default deny. The proxy creates per-session Unix sockets, auto-detects the upstream Docker daemon (DinD or DooD), and provides container-name-based filtering via glob patterns.

## Credentials Architecture — Phase 3 (parallel with #463 and #465)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decisions #13 and #16, and the "Scoped docker socket proxy" section.

**Depends on:** Phase 2 (#461 daemon — provides session lifecycle, #462 config loading — provides role docker blocks)

## What needs to be done

Implement a scoped docker socket proxy inside `packages/credhelper/`. The proxy mediates all docker API access from workflow processes, enforcing per-role method+path allowlists with default deny.

### Architecture

- The credhelper creates a per-session proxy socket at `/run/generacy-credhelper/sessions/<id>/docker.sock`
- Workflow processes see `DOCKER_HOST=unix:///run/generacy-credhelper/sessions/<id>/docker.sock`
- The proxy intercepts each Docker API request, matches against the role's allowlist, and forwards to the upstream socket or rejects

### Upstream socket selection (decision #16)

The proxy is **uniform across cluster variants** — same code, same allowlist logic. Only the upstream differs:

1. If `ENABLE_DIND=true` AND `/var/run/docker.sock` is reachable → forward to `/var/run/docker.sock` (DinD daemon)
2. Else if `/var/run/docker-host.sock` is mounted → forward to `/var/run/docker-host.sock` (host docker, DooD)
3. Else → fail closed at credhelper boot with clear error

### Role schema for docker allowlists

Roles declare allowed docker API operations:

```yaml
docker:
  default: deny
  allow:
    - { method: GET,  path: /containers/json }
    - { method: GET,  path: "/containers/{id}/json" }
    - { method: POST, path: "/containers/{id}/start",   name: "firebase-*" }
    - { method: POST, path: "/containers/{id}/stop",    name: "firebase-*" }
    - { method: GET,  path: "/containers/{id}/logs" }
```

### Enforcement

- Parse each incoming HTTP request on the proxy socket
- **Strip Docker API version prefix** before matching: incoming paths like `/v1.41/containers/json` are normalized to `/containers/json` using `requestPath.replace(/^\/v\d+\.\d+/, '')`. Role configs always use unversioned paths.
- Match `method` + normalized `path` against the role's allowlist
- For container-scoped operations (paths with `{id}`): resolve the container ID to its name, match against the `name` glob pattern if specified. If `name` is omitted from the rule, any container is allowed for that method+path.
- **Container name resolution failure**: if a name lookup fails for a rule with a `name` glob, deny the request (fail closed) with HTTP 403 message: "container name resolution failed for ID {id} — request denied by name-based policy"
- **Default deny** — anything not explicitly in the allowlist is rejected with HTTP 403
- **Streaming restriction**: `GET /containers/{id}/logs` with `follow=true` query parameter is rejected with HTTP 403 (unbounded streaming is out of scope). Logs without `follow=true` work normally via chunked transfer encoding.
- Dangerous paths (`POST /containers/create` with arbitrary bind mounts, `POST /exec`, etc.) should only be allowed if explicitly listed. The allowlist entry itself is the constraint — the proxy logs a security warning when forwarding to known-dangerous paths but does not perform request body inspection (deferred to Phase 4).

### Security note for non-DinD clusters (cluster-base)

When the upstream is the host docker socket, `POST /containers/create` with bind mounts is effectively granting host filesystem access. The proxy should:
- Log a warning at boot if the role allows `POST /containers/create` and the upstream is the host socket
- The role validation in #462 should surface this as a warning

### Per-session lifecycle

- On session begin: create the proxy socket, bind to it, start forwarding
- On session end: close the proxy socket, tear down proxy state
- The proxy runs as part of the credhelper daemon process (same uid 1002), not as a separate process

### Implementation approach

Follow the pattern from [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) but implemented in Node.js:
- HTTP CONNECT-style proxying over Unix sockets
- Request parsing to extract method + path
- Allowlist matching with glob support for container names

## Acceptance criteria

- Proxy socket is created per session and cleaned up on session end
- Allowed requests are forwarded correctly and responses returned
- Denied requests return HTTP 403 with clear error message naming the denied method+path
- Container name-based filtering works (resolve ID → name → glob match)
- Upstream auto-detection works for both DinD (`/var/run/docker.sock`) and DooD (`/var/run/docker-host.sock`)
- Fails closed when no upstream socket is available
- Unit tests: allowlist matching, glob patterns, deny by default
- Integration test with a real docker socket (can use DinD in tetrad-development)

## Phase grouping

- **Phase 3** — parallel with #463 and #465
- **Rebuild cluster after Phase 3 completes**

## User Stories

### US1: Workflow process isolation via Docker API scoping

**As a** platform operator,
**I want** workflow processes to only access Docker API operations explicitly allowed by their role,
**So that** a compromised or misconfigured workflow cannot escalate privileges, manipulate unrelated containers, or access the host filesystem via Docker.

**Acceptance Criteria**:
- [ ] Each session gets its own proxy socket at `/run/generacy-credhelper/sessions/<id>/docker.sock`
- [ ] Requests matching the role's allowlist are forwarded and responses returned correctly
- [ ] Requests not in the allowlist are rejected with HTTP 403 and a clear error message
- [ ] Proxy socket is cleaned up when the session ends

### US2: Uniform proxy behavior across cluster variants

**As a** platform developer,
**I want** the proxy to work identically on DinD and DooD clusters with only the upstream socket differing,
**So that** I don't need to maintain separate proxy implementations or configurations per cluster type.

**Acceptance Criteria**:
- [ ] Proxy auto-detects upstream socket (DinD via `ENABLE_DIND` + `/var/run/docker.sock`, or DooD via `/var/run/docker-host.sock`)
- [ ] Fails closed with clear error when no upstream is available
- [ ] Allowlist enforcement is identical regardless of upstream

### US3: Container-name-scoped access control

**As a** role author,
**I want** to restrict Docker operations to containers matching a name glob pattern (e.g., `firebase-*`),
**So that** workflows can manage their own containers without being able to affect others.

**Acceptance Criteria**:
- [ ] Container IDs are resolved to names for rules with `name` glob patterns
- [ ] Glob matching works correctly (e.g., `firebase-*` matches `firebase-emulator` but not `redis`)
- [ ] Rules without a `name` field allow any container for that method+path

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Per-session proxy socket creation at `/run/generacy-credhelper/sessions/<id>/docker.sock` | P1 | Socket created on session begin, removed on session end |
| FR-002 | HTTP request parsing to extract method + path from incoming Docker API requests, stripping version prefix (`/v\d+\.\d+`) before matching | P1 | Role configs use unversioned paths; proxy normalizes |
| FR-003 | Allowlist matching: method + path checked against role's `docker.allow` rules | P1 | Default deny — anything not listed is rejected with 403 |
| FR-004 | Container name resolution: resolve container ID → name for `{id}` path patterns with `name` globs. Fail closed (HTTP 403) if resolution fails. Skip resolution when `name` is omitted. | P1 | Cache name lookups to reduce upstream calls |
| FR-005 | Upstream socket auto-detection (DinD → `/var/run/docker.sock`, DooD → `/var/run/docker-host.sock`) | P1 | Fail closed if neither is available |
| FR-006 | HTTP 403 response for denied requests with clear error naming the denied method+path | P1 | |
| FR-007 | Request forwarding to upstream socket and response relay back to client | P1 | Must handle chunked transfer encoding. Reject `follow=true` query param on logs endpoint (unbounded streaming out of scope). |
| FR-008 | Security warning log at boot when role allows `POST /containers/create` on host socket upstream | P2 | DooD bind-mount risk |
| FR-009 | Proxy runs in-process with credhelper daemon (same uid 1002), not as separate process | P1 | |
| FR-010 | Session cleanup tears down proxy socket and all proxy state | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Allowed requests forwarded correctly | 100% | Integration test against real Docker socket |
| SC-002 | Denied requests return 403 | 100% | Unit tests for allowlist matching with default deny |
| SC-003 | Container name glob matching | Correct for all patterns | Unit tests with various glob patterns |
| SC-004 | Upstream auto-detection | Works for DinD and DooD | Integration test in tetrad-development |
| SC-005 | Session cleanup | No leaked sockets or state | Verify socket removed and connections closed on session end |
| SC-006 | Fail-closed on missing upstream | Credhelper refuses to boot | Test with no Docker socket available |

## Assumptions

- Phase 2 (#461 daemon, #462 config loading) is complete and provides session lifecycle hooks and role docker block schemas
- The `DockerRule` Zod schema from `packages/credhelper` defines the allowlist structure
- The credhelper daemon already manages per-session directories under `/run/generacy-credhelper/sessions/<id>/`
- Container name resolution uses the upstream Docker API (`GET /containers/{id}/json`)
- Glob matching uses a standard library (e.g., `minimatch` or `picomatch`)

## Out of Scope

- Docker API streaming endpoints (attach, exec stream, logs with `follow=true`) — only standard request-response proxying with chunked transfer encoding support
- Request body inspection for dangerous patterns (e.g., bind mount validation) — Phase 3 logs warnings only; body inspection deferred to Phase 4
- Multi-upstream routing (only one upstream per credhelper instance)
- Docker Compose or BuildKit API proxying
- Rate limiting or quota enforcement on Docker API calls
- TLS/mTLS between proxy and upstream (Unix sockets only)

---

*Generated by speckit*
