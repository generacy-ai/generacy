# Clarifications: Scoped Docker Socket Proxy (#464)

## Batch 1 — 2026-04-13

### Q1: Docker API version prefix handling
**Context**: Docker clients (including the Docker CLI) prefix API paths with a version string, e.g., `/v1.41/containers/json` or `/v1.45/containers/{id}/start`. The allowlist examples in the spec and the `DockerRule` schema use unversioned paths like `/containers/json`. The proxy's path-matching logic fundamentally depends on how version prefixes are handled.
**Question**: Should the proxy strip the `/v<N.NN>` prefix before matching against allowlist rules, so that role configs use unversioned paths? Or should allowlist entries include the version prefix?
**Options**:
- A: Strip the version prefix before matching (role configs stay unversioned, proxy normalizes)
- B: Require version prefix in allowlist entries (role configs must include `/v1.41/...`)
- C: Support both — match with or without version prefix

**Answer**: *Pending*

### Q2: Streaming response support (logs endpoint)
**Context**: The example allowlist includes `GET /containers/{id}/logs`, but the spec lists "Docker API streaming endpoints (attach, exec stream)" as out of scope. Docker logs with `follow=true` is a long-lived streaming response using chunked transfer encoding. Many non-streaming Docker API responses also use chunked encoding. This distinction affects the proxy's response handling implementation.
**Question**: Should the proxy support chunked/streaming responses for allowed endpoints like logs? Or should only request-response (non-streaming) Docker API calls be proxied in this phase?
**Options**:
- A: Support chunked/streaming responses for all allowed endpoints (logs with `follow=true` works)
- B: Support chunked responses but not long-lived streams (logs without `follow` works, `follow=true` is rejected or times out)
- C: Only non-streaming request-response proxying (logs may partially work but is not guaranteed)

**Answer**: *Pending*

### Q3: Request body inspection for dangerous paths
**Context**: The spec states dangerous paths like `POST /containers/create` with arbitrary bind mounts "should only be allowed if explicitly listed AND constrained." The word "constrained" is ambiguous — it could mean the allowlist entry itself is the constraint (i.e., the admin consciously listed it), or it could mean the proxy should inspect the request body to enforce additional constraints (e.g., reject bind mounts to sensitive host paths).
**Question**: Does "constrained" mean (a) the allowlist entry is the constraint and the proxy just logs a warning, or (b) the proxy should perform request body inspection to enforce additional safety checks beyond method+path matching?
**Options**:
- A: Allowlist entry is the constraint — proxy logs security warning but forwards if method+path matches (body inspection is out of scope for Phase 3)
- B: Proxy should inspect request body for known dangerous patterns (e.g., bind mounts to `/`, `/etc`, `/var/run/docker.sock`) and deny even if method+path is allowed

**Answer**: *Pending*

### Q4: Container name resolution failure handling
**Context**: FR-004 requires resolving container IDs to names for glob matching, with caching. But the spec doesn't specify behavior when name resolution fails — e.g., the container was deleted between the request arriving and the name lookup, the upstream API returns an error, or the container ID is invalid.
**Question**: When a container name lookup fails for a request matching a `{id}` path with a `name` glob filter, should the proxy deny the request (fail closed), return a specific error code, or skip the name check and allow based on method+path alone?
**Options**:
- A: Deny the request (fail closed) — if we can't verify the name, we don't allow it
- B: Return HTTP 502 (upstream error) to distinguish from 403 (policy deny)
- C: Skip name check and allow if method+path matches (fail open for name resolution only)

**Answer**: *Pending*

### Q5: Omitted `name` field semantics for container-scoped paths
**Context**: The `DockerRule` schema makes `name` optional. The allowlist example shows some container-scoped paths (with `{id}`) that have a `name` glob and some that don't (e.g., `GET /containers/{id}/json` has no `name`, while `POST /containers/{id}/start` has `name: "firebase-*"`). This is likely intentional, but the spec doesn't explicitly state the behavior.
**Question**: When a `name` field is omitted from an allowlist entry for a container-scoped path, does that mean any container is allowed for that method+path combination (i.e., no name filtering)?

**Answer**: *Pending*
