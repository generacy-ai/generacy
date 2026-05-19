# Quickstart: Scoped Docker Socket Proxy

## Overview

This feature enables roles with a `docker:` block to get a per-session scoped Docker socket. The proxy enforces allowlist rules and (for host-socket mode) restricts bind mounts to a per-session scratch directory.

## Role Configuration

Add a `docker:` block to your role in `.agency/roles/<role-id>.yaml`:

```yaml
schemaVersion: '1'
id: fullstack-developer
description: Full-stack developer with limited Docker access
credentials:
  - ref: github-pat
    expose:
      - as: env
      - as: docker-socket-proxy
docker:
  default: deny
  allow:
    - method: GET
      path: /containers/json
    - method: POST
      path: /containers/{id}/start
    - method: POST
      path: /containers/{id}/stop
    - method: POST
      path: /containers/create
```

## How It Works

### Session Lifecycle

1. **Session begin**: Credhelper daemon creates:
   - `$GENERACY_SESSION_DIR/docker.sock` — scoped Docker proxy socket
   - `/var/lib/generacy/scratch/<session-id>/` — scratch directory for bind mounts
2. **During session**: Workflow process uses `DOCKER_HOST` and `GENERACY_SCRATCH_DIR` env vars
3. **Session end**: Proxy stops, scratch directory is cleaned up

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DOCKER_HOST` | `unix://$GENERACY_SESSION_DIR/docker.sock` — proxy socket |
| `GENERACY_SCRATCH_DIR` | `/var/lib/generacy/scratch/<session-id>/` — bind mount root |

### Upstream Selection

The daemon selects the upstream Docker socket at boot:

| Condition | Socket | Mode | Bind-Mount Guard |
|-----------|--------|------|------------------|
| `ENABLE_DIND=true` + `/var/run/docker.sock` exists | `/var/run/docker.sock` | DinD | Disabled |
| `/var/run/docker-host.sock` exists | `/var/run/docker-host.sock` | Host | Enabled |
| Neither exists | N/A | Disabled | N/A |

## Usage Examples

### Running `docker ps` (allowed)

```bash
# Inside a workflow session with the role above:
docker ps
# Works — GET /containers/json is in the allowlist
```

### Running `docker build` (denied)

```bash
docker build .
# Returns HTTP 403: No allowlist rule matched POST /build
```

### Using bind mounts (host-socket mode)

```bash
# Must use GENERACY_SCRATCH_DIR for bind mounts:
docker run -v $GENERACY_SCRATCH_DIR/data:/app/data ubuntu ls /app/data
# Works — mount is under scratch directory

docker run -v /etc:/app/etc ubuntu ls /app/etc
# Returns HTTP 403: bind mount outside scratch directory
```

## Testing

### Run unit tests

```bash
cd packages/credhelper-daemon
pnpm test -- --grep "bind-mount"
pnpm test -- --grep "docker-proxy"
```

### Run integration tests

```bash
cd packages/credhelper-daemon
pnpm test -- --grep "docker-integration"
```

## Troubleshooting

### "No Docker socket detected"
- At daemon boot, this is a warning (not an error). Non-Docker roles continue working.
- If a role with `docker:` block begins a session, it will fail with `DOCKER_UPSTREAM_NOT_FOUND`.
- Check that either `/var/run/docker.sock` (with `ENABLE_DIND=true`) or `/var/run/docker-host.sock` exists and is writable.

### "bind mount outside scratch directory"
- Host-socket mode restricts bind mounts to `GENERACY_SCRATCH_DIR`.
- Copy your data into `$GENERACY_SCRATCH_DIR` before mounting.
- This restriction does NOT apply in DinD mode.

### "Docker API access denied"
- The request method+path didn't match any rule in the role's `docker.allow` list.
- Check the error `details.method` and `details.path` to see what was attempted.
- Add the appropriate rule to the role's `docker.allow` array.
