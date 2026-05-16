# Research: Fetch Registry Credentials for `generacy update`

## Technology Decisions

### 1. CLI-to-Container Communication: `docker compose exec`

**Decision**: Use `docker compose exec -T` with `curl` to query the control-plane socket from inside the container.

**Alternatives considered**:
- **Bind-mount the socket**: Exposes the Unix socket to the host filesystem. Rejected because it changes the security boundary (control-plane is intentionally socket-only for in-cluster access), requires compose file changes, and cross-platform socket permissions are complex.
- **Expose an HTTP port**: Map a container port for the control-plane. Rejected because it exposes credential endpoints to the network (violates "restricted to local Unix socket callers") and requires firewall configuration.
- **Cloud relay path**: Route request through the cloud relay. Rejected because it requires cloud auth, adds latency, and the CLI should work offline-from-cloud.

**Why `docker compose exec`**:
- Reuses existing compose infrastructure (project name, file path already resolved)
- Stays within the container's security perimeter
- `curl` is guaranteed present in cluster images (alpine/debian base)
- `-T` flag avoids TTY allocation for non-interactive use
- Failure mode is clear: if container isn't running, exec fails → cluster-offline path

### 2. Docker Config Format: Standard Docker JSON

**Decision**: Write standard Docker `config.json` format at `.generacy/.docker/config.json`.

```json
{
  "auths": {
    "ghcr.io": {
      "auth": "base64(username:password)"
    }
  }
}
```

**Rationale**: This is the canonical Docker credential format that `docker compose pull` reads via `DOCKER_CONFIG` env var. No credential helpers or store references needed for short-lived scoped configs.

### 3. Image Host Extraction: YAML Parse from Compose File

**Decision**: Parse the `image:` field from the compose file to extract the registry host.

**Pattern**:
- `ghcr.io/org/image:tag` → host is `ghcr.io`
- `registry.example.com/image:tag` → host is `registry.example.com`
- `ubuntu:22.04` or `node:20` → no host prefix = Docker Hub (skip credential lookup)

**Implementation**: Simple string split on first `/`. If the first segment contains `.` or `:` (port), it's a registry host. Otherwise, it's a Docker Hub library image.

### 4. Credential ID Convention: `registry-<host>`

**Decision**: Credential IDs follow the pattern `registry-<host>` (e.g., `registry-ghcr.io`).

**Rationale**: Defined by the sibling issue that forwards credentials during launch. The host is the natural unique key since each cluster image comes from a single registry.

### 5. Scoped Config Location: `.generacy/.docker/`

**Decision**: Place the scoped Docker config at `<projectDir>/.generacy/.docker/config.json`.

**Alternatives**:
- `os.tmpdir()`: Fully isolated but loses project-scoping context and requires more complex path management.
- Project root `.docker/`: Could conflict with user conventions or be accidentally committed.

**Why `.generacy/.docker/`**: Already CLI-managed directory, inherits existing gitignore patterns, clear ownership semantics.

### 6. Cleanup Strategy: `try/finally` + Process Signal Handlers

**Decision**: Wrap the pull operation in `try/finally` with additional `process.on('SIGINT'/'SIGTERM')` handlers.

```typescript
try {
  await materializeScopedDockerConfig(...)
  await runComposePull(ctx, { env: { DOCKER_CONFIG: ... } })
} finally {
  await cleanupScopedDockerConfig(...)
}
```

**Edge cases**:
- `SIGINT` (Ctrl+C): Node.js `finally` blocks execute on SIGINT by default.
- `SIGKILL`: Unhandleable. Stale `.generacy/.docker/` directory may remain. Non-harmful (overwritten next time, no secrets leak since file has restrictive permissions).
- `SIGTERM`: Handled via listener that triggers cleanup before exit.

### 7. Error Handling: Fail-Open with Warning

**Decision**: Credential fetch failures are non-fatal. The update proceeds with ambient Docker login.

**Rationale**: `generacy update` should never fail harder than Docker itself would. If the registry is public or the user has `docker login` configured, the ambient path works. Private registries without credentials will fail at the `docker compose pull` stage with Docker's own error message (which is actionable).

## Key Implementation Patterns

### Existing Patterns to Follow

1. **Route handler pattern** (control-plane): `handleXxx(req, res, params, options)` with Zod validation
2. **Compose runner pattern**: `runCompose(ctx, subcommand, options?)` with `execSafe()` under the hood
3. **Context resolution**: `getClusterContext()` walks up from cwd to find `.generacy/`
4. **Docker availability check**: `ensureDocker()` before any compose operations

### New Patterns Introduced

1. **Container exec for API queries**: Wraps `docker compose exec -T` for in-cluster HTTP calls
2. **Scoped config lifecycle**: Create/use/cleanup pattern for temporary Docker credentials
3. **Image host extraction**: Pure function that parses compose file for registry hostname

## References

- Docker `config.json` format: https://docs.docker.com/reference/cli/docker/login/#credential-stores
- `DOCKER_CONFIG` env var: https://docs.docker.com/reference/cli/docker/#environment-variables
- Docker image reference spec: `[REGISTRY/]REPOSITORY[:TAG|@DIGEST]`
