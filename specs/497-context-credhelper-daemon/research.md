# Research: Wire scoped docker-socket-proxy into ExposureRenderer

## Technology Decisions

### 1. Bind-Mount Path Validation Strategy

**Decision**: Canonicalize source paths with `path.resolve()` then check `startsWith(scratchDir)`.

**Rationale**: The Docker Engine API accepts bind mounts in two formats:
- `HostConfig.Binds`: Array of strings like `"/host/path:/container/path:ro"`
- `HostConfig.Mounts`: Array of objects `{Type: "bind", Source: "/host/path", Target: "/container/path"}`

Both allow relative paths and `../` sequences. Using `path.resolve()` canonicalizes before comparison. We do NOT use `fs.realpath()` at validation time because:
- The path may not exist yet (the container might create it)
- Symlink resolution requires filesystem access which adds latency
- `path.resolve()` handles `..` traversal which is the primary attack vector

**Alternatives considered**:
- A: `fs.realpath()` — Requires path to exist, adds I/O latency
- B: Regex-based path matching — Fragile, doesn't handle all edge cases
- C: chroot/namespace isolation — Overkill for this layer; Docker itself handles post-creation isolation

### 2. Request Body Buffering

**Decision**: Buffer request body only for `POST /containers/create` when `upstreamIsHost=true`.

**Rationale**: We need to inspect the JSON body to find bind mount entries. Buffering the entire body is necessary because:
- Node.js `http.IncomingMessage` is a stream — can only be consumed once
- We need to parse JSON, inspect mounts, then forward the original body to upstream
- The Docker create payload is typically small (< 50KB)

**Implementation**: Buffer into string, parse JSON, validate, then write buffered body to upstream request. Add a 10MB size limit to prevent abuse.

### 3. Scratch Directory Location

**Decision**: `/var/lib/generacy/scratch/<session-id>/` — matches existing credential store location convention.

**Rationale**:
- `/var/lib/generacy/` is already used by `cluster-local-backend.ts` for `master.key` and `credentials.dat`
- Per-session subdirectory provides isolation
- Real disk (not tmpfs) so data persists across container restarts within a session
- Mode 0700, owned by workflow uid (1001) — only the workflow process can access

**Alternatives considered**:
- A: `$GENERACY_SESSION_DIR/scratch` — Mixes ephemeral session state with persistent scratch data
- B: `/tmp/generacy-scratch/<session-id>` — tmpfs on many systems, data lost on reboot
- C: Configurable per-role — Over-engineered for current needs

### 4. DinD vs Host-Socket Allowlist Differentiation

**Decision**: DinD mode skips bind-mount restrictions entirely; host-socket mode enforces them.

**Rationale**: In DinD mode, the Docker daemon runs inside the container. Any bind mounts reference paths within the container's own filesystem, which is already isolated. The host-socket path forwards to the real Docker daemon on the host, so bind mounts could escape the container boundary.

This distinction is implemented by checking `upstreamIsHost` in the proxy handler — the bind-mount guard is only invoked when `upstreamIsHost=true`.

### 5. Error Response Format

**Decision**: Use existing `DOCKER_ACCESS_DENIED` error code with descriptive details.

```json
{
  "error": "Docker API access denied: POST /containers/create — bind mount outside scratch directory",
  "code": "DOCKER_ACCESS_DENIED",
  "details": {
    "method": "POST",
    "path": "/containers/create",
    "reason": "bind_mount_outside_scratch",
    "rejectedPaths": ["/etc/passwd"],
    "allowedPrefix": "/var/lib/generacy/scratch/session-123/"
  }
}
```

## Implementation Patterns

### Body Interception Pattern

```typescript
// Only intercept POST /containers/create on host-socket
if (upstreamIsHost && method === 'POST' && normalizedPath === '/containers/create') {
  const body = await bufferBody(clientReq, MAX_BODY_SIZE);
  const parsed = JSON.parse(body);
  const violations = validateBindMounts(parsed, scratchDir);
  if (violations.length > 0) {
    sendDeny(clientRes, method, normalizedPath, 'bind_mount_outside_scratch', {
      rejectedPaths: violations,
      allowedPrefix: scratchDir,
    });
    return;
  }
  // Forward with buffered body
  forwardWithBody(clientReq, clientRes, upstreamSocket, method, rawUrl, body);
  return;
}
```

### Bind Mount Extraction

Docker API `HostConfig.Binds` format: `"source:target[:options]"`
Docker API `HostConfig.Mounts` format:
```json
{
  "Type": "bind",
  "Source": "/host/path",
  "Target": "/container/path",
  "ReadOnly": false
}
```

Only `Type: "bind"` entries need validation — `volume` and `tmpfs` types don't reference host paths.

### Scratch Directory Lifecycle

```
Session begin:
  1. Create /var/lib/generacy/scratch/<sessionId>/ (mode 0700, chown uid:gid)
  2. Set GENERACY_SCRATCH_DIR env var
  3. Start Docker proxy (with scratchDir for bind-mount guard)

Session end:
  1. Stop Docker proxy
  2. rm -rf /var/lib/generacy/scratch/<sessionId>/
```

## Key Sources

- Docker Engine API v1.41: `POST /containers/create` — [docs.docker.com](https://docs.docker.com/engine/api/v1.41/#tag/Container/operation/ContainerCreate)
- Existing `DockerProxy` implementation: `packages/credhelper-daemon/src/docker-proxy.ts`
- Existing allowlist: `packages/credhelper-daemon/src/docker-allowlist.ts`
- Credentials architecture plan: `docs/credentials-architecture-plan.md` (in tetrad-development)
- Node.js `path.resolve()`: Canonicalizes `../` without filesystem access
