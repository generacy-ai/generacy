# Research: Forward Registry Credentials to Credhelper

## Technology Decisions

### Docker Compose Exec for In-Container HTTP

**Decision**: Use `docker compose exec -T` to run `curl` inside the container rather than exposing the control-plane socket to the host.

**Rationale**:
- Control-plane Unix socket (`/run/generacy-control-plane/control.sock`) lives inside the container
- No port mapping exists for the control-plane (by design — security boundary)
- `docker compose exec` is already used in the launch flow (e.g., `claude-login` command)
- `-T` flag disables TTY allocation (needed for non-interactive CLI calls)

**Alternatives considered**:
- Docker volume mount for socket → exposes internal service externally, violates security model
- HTTP port mapping → requires compose file changes, increases attack surface
- `docker exec` directly → requires container ID lookup, less portable than compose exec

### Readiness Probe Strategy

**Decision**: Poll `GET /state` endpoint over Unix socket with retry loop.

**Rationale**:
- `GET /state` is the simplest endpoint (no auth required beyond actor header, returns cluster state)
- Socket probe alone (TCP connect) doesn't guarantee HTTP handler readiness
- Retry loop (10x, 2s interval) gives 20s window — matches orchestrator's control-plane wait timeout (15s)

**Alternatives considered**:
- TCP socket probe only → doesn't verify HTTP layer is accepting requests
- Single attempt with long timeout → poor UX if control-plane is slow
- Wait for specific log line → fragile, depends on log format stability

### Credential ID Convention

**Decision**: `registry-<host>` (e.g., `registry-ghcr.io`, `registry-private.example.com`)

**Rationale**:
- Unique per registry host (allows multiple registries in future)
- Human-readable in audit logs and cloud UI
- No collision with existing credential ID patterns (`github-app`, `github-pat`, `anthropic`, etc.)
- Hyphen-separated prefix groups related credentials in sorted listings

### Cleanup Strategy

**Decision**: Delete entire `.generacy/.docker/` directory (not just `config.json`).

**Rationale**:
- CLI created the directory during pull step (sibling issue #641)
- Empty directories serve no purpose and confuse users
- Single `rm -rf` is simpler than file deletion + empty-dir check
- Uses `fs.rm(path, { recursive: true, force: true })` — idempotent

## Implementation Patterns

### Error Handling Pattern (Non-Fatal)

```typescript
try {
  const result = await forwardRegistryCredentials(projectDir, creds);
  if (result.forwarded.length > 0) cleanupScopedDockerConfig(projectDir);
  if (result.failed.length > 0) logger.warn(...);
} catch (e) {
  logger.warn('Credential forwarding failed:', e.message);
  // Continue launch — don't throw
}
```

Matches the spec's "failure to forward is logged but doesn't abort the launch" requirement.

### Docker Compose Exec Pattern (from claude-login command)

```typescript
const { status } = spawnSync('docker', [
  'compose', '-f', composePath, 'exec', '-T', 'orchestrator',
  'curl', '--unix-socket', SOCKET_PATH, '-sf',
  '-X', 'PUT', `http://localhost/credentials/${credId}`,
  '-H', 'Content-Type: application/json',
  '-H', 'x-generacy-actor-user-id: system:cli-launch',
  '-d', JSON.stringify(body)
], { cwd: projectDir, stdio: 'pipe' });
```

### Retry Loop Pattern

```typescript
async function probeControlPlaneReady(projectDir: string, opts = { retries: 10, intervalMs: 2000 }): Promise<boolean> {
  for (let i = 0; i < opts.retries; i++) {
    if (probeOnce(projectDir)) return true;
    await sleep(opts.intervalMs);
  }
  return false;
}
```

## Key Sources

- Control-plane probe: `packages/orchestrator/src/services/control-plane-probe.ts`
- Credential routes: `packages/control-plane/src/routes/credentials.ts`
- Launch compose helpers: `packages/generacy/src/cli/commands/launch/compose.ts`
- Claude-login exec pattern: `packages/generacy/src/cli/commands/claude-login/`
- Cluster scaffolder: `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
