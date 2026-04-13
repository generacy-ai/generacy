# Feature Specification: Scoped Docker Socket Proxy

**Branch**: `464-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft | **Issue**: [#464](https://github.com/generacy-ai/generacy/issues/464)

## Summary

Implement a scoped docker socket proxy inside `packages/credhelper/` that mediates all Docker API access from workflow processes. The proxy enforces per-role method+path allowlists with default deny, providing fine-grained Docker API access control as part of the credentials architecture (Phase 3).

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). See decisions #13 and #16, and the "Scoped docker socket proxy" section.

**Depends on:** Phase 2 (#461 daemon — provides session lifecycle, #462 config loading — provides role docker blocks)

## Architecture

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
- Match `method` + `path` against the role's allowlist
- For container-scoped operations (paths with `{id}`): resolve the container ID to its name, match against the `name` glob pattern if specified
- **Default deny** — anything not explicitly in the allowlist is rejected with HTTP 403
- Dangerous paths (`POST /containers/create` with arbitrary bind mounts, `POST /exec`, etc.) should only be allowed if explicitly listed AND constrained

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

## User Stories

### US1: Workflow process Docker access

**As a** workflow process running under a credhelper session,
**I want** Docker API access scoped to only the operations my role permits,
**So that** I can manage containers needed for my workflow without gaining unrestricted Docker API access.

**Acceptance Criteria**:
- [ ] Workflow sees `DOCKER_HOST` pointing to the per-session proxy socket
- [ ] Allowed Docker API calls (e.g., list containers, start/stop named containers) succeed
- [ ] Disallowed Docker API calls are rejected with HTTP 403

### US2: Platform operator security enforcement

**As a** platform operator defining roles,
**I want** Docker API access controlled via declarative allowlists in role configuration,
**So that** I can grant least-privilege Docker access per role without custom proxy configuration.

**Acceptance Criteria**:
- [ ] Role config `docker.allow` entries control which API calls are permitted
- [ ] Container name glob patterns restrict container-scoped operations to matching names
- [ ] Default deny ensures no Docker access without explicit allowlist entries

### US3: Cluster-agnostic deployment

**As a** platform operator,
**I want** the Docker socket proxy to work identically across DinD and DooD cluster variants,
**So that** I can use the same role definitions regardless of cluster topology.

**Acceptance Criteria**:
- [ ] Proxy auto-detects upstream socket (DinD vs DooD)
- [ ] Same allowlist rules apply regardless of upstream
- [ ] Security warnings are logged when host socket access + container create is allowed

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Per-session proxy socket creation at `/run/generacy-credhelper/sessions/<id>/docker.sock` | P1 | Created on session begin, removed on session end |
| FR-002 | HTTP request parsing to extract method + path from Docker API calls | P1 | Standard HTTP/1.1 over Unix socket |
| FR-003 | Allowlist matching: method + path against role's `docker.allow` entries | P1 | Default deny for unmatched requests |
| FR-004 | Container name resolution: resolve container ID to name for `{id}` paths | P1 | Cache container name lookups |
| FR-005 | Glob pattern matching on container names (e.g., `firebase-*`) | P1 | Use minimatch or equivalent |
| FR-006 | HTTP 403 response with descriptive error for denied requests | P1 | Include denied method+path in message |
| FR-007 | Upstream socket auto-detection (DinD → DooD → fail closed) | P1 | Check `ENABLE_DIND` env + socket reachability |
| FR-008 | Full request/response proxying for allowed requests | P1 | Stream bodies, preserve headers |
| FR-009 | Security warning log when role allows `POST /containers/create` on host socket | P2 | DooD-specific risk |
| FR-010 | Proxy runs in-process within the credhelper daemon (uid 1002) | P1 | No separate process |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Allowlist enforcement accuracy | 100% deny for unlisted operations | Unit tests with comprehensive method+path combinations |
| SC-002 | Proxy latency overhead | < 5ms per request | Benchmark allowed requests vs direct socket |
| SC-003 | Session cleanup reliability | 0 leaked proxy sockets after session end | Integration test: create session, end session, verify socket removed |
| SC-004 | Container name resolution | Correct glob matching for all test patterns | Unit tests with various name patterns and glob expressions |
| SC-005 | Cross-cluster compatibility | Works on both DinD and DooD | Integration tests in both cluster configurations |

## Assumptions

- Phase 2 packages (#461, #462) are complete and provide session lifecycle hooks and role docker configuration
- The credhelper daemon has sufficient permissions (uid 1002) to create Unix sockets under `/run/generacy-credhelper/`
- Docker API follows standard HTTP/1.1 protocol over Unix sockets
- Container name lookups via `GET /containers/{id}/json` are available on the upstream socket
- Role configuration schema from #462 includes the `docker` block with `default` and `allow` fields

## Out of Scope

- Docker API streaming endpoints (attach, exec stream) — may be added in a future phase if needed
- Rate limiting or quota enforcement on Docker API calls
- Audit logging of allowed/denied requests (beyond the security warning for host socket + container create)
- Multi-tenant isolation beyond per-session proxy sockets
- Docker Compose or higher-level orchestration proxying

---

*Generated by speckit*
