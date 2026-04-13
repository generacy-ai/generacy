# Quickstart: Scoped Docker Socket Proxy

## Installation

```bash
# From the monorepo root
cd /workspaces/generacy
pnpm install
pnpm --filter @generacy-ai/credhelper build
pnpm --filter @generacy-ai/credhelper-daemon build
```

## How It Works

When a session is created with a role that uses `docker-socket-proxy` exposure, the credhelper daemon:

1. Creates a per-session proxy socket at `/run/generacy-credhelper/sessions/<id>/docker.sock`
2. Sets `DOCKER_HOST=unix:///run/generacy-credhelper/sessions/<id>/docker.sock` in the session env
3. Intercepts every Docker API request on the proxy socket
4. Matches against the role's `docker.allow` rules (method + path + optional name glob)
5. Forwards allowed requests to the upstream Docker daemon; rejects denied requests with HTTP 403

## Role Configuration Example

```yaml
# .agency/roles/firebase-runner.yaml
schemaVersion: '1'
id: firebase-runner
description: Role for running Firebase emulators
credentials:
  - ref: gcp-sa
    expose:
      - as: docker-socket-proxy
docker:
  default: deny
  allow:
    - { method: GET,  path: /containers/json }
    - { method: GET,  path: "/containers/{id}/json" }
    - { method: POST, path: "/containers/{id}/start",  name: "firebase-*" }
    - { method: POST, path: "/containers/{id}/stop",   name: "firebase-*" }
    - { method: GET,  path: "/containers/{id}/logs" }
```

## Testing with curl

### Start the daemon (development)

```bash
# Build
pnpm --filter @generacy-ai/credhelper-daemon build

# Run tests
pnpm --filter @generacy-ai/credhelper-daemon test
```

### Test the proxy manually (requires a running session)

```bash
# Create a session with a docker-enabled role
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X POST http://localhost/sessions \
  -H 'Content-Type: application/json' \
  -d '{"role": "firebase-runner", "sessionId": "sess-test"}'

# Allowed: list containers through the proxy
curl --unix-socket /run/generacy-credhelper/sessions/sess-test/docker.sock \
  http://localhost/v1.41/containers/json

# Allowed: inspect a specific container
curl --unix-socket /run/generacy-credhelper/sessions/sess-test/docker.sock \
  http://localhost/v1.41/containers/abc123/json

# Denied: create a container (not in allowlist)
curl --unix-socket /run/generacy-credhelper/sessions/sess-test/docker.sock \
  -X POST http://localhost/v1.41/containers/create \
  -H 'Content-Type: application/json' \
  -d '{"Image": "alpine"}'
# Returns: 403 {"error": "Docker API access denied: POST /containers/create", "code": "DOCKER_ACCESS_DENIED"}

# Denied: streaming logs (follow=true rejected)
curl --unix-socket /run/generacy-credhelper/sessions/sess-test/docker.sock \
  "http://localhost/v1.41/containers/abc123/logs?stdout=true&follow=true"
# Returns: 403 {"error": "streaming logs (follow=true) is not supported through the scoped proxy"}

# End session (cleans up proxy socket)
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X DELETE http://localhost/sessions/sess-test
```

## Session Directory Layout

After session creation with docker proxy:

```
/run/generacy-credhelper/sessions/sess-test/
├── env                # includes DOCKER_HOST=unix:///run/.../sess-test/docker.sock
├── docker.sock        # scoped proxy socket (NEW)
├── data.sock          # credential data server
├── git/               # (if git exposure configured)
└── gcp/               # (if gcloud exposure configured)
```

## Running Tests

```bash
# Unit tests (allowlist matching, name resolution, etc.)
pnpm --filter @generacy-ai/credhelper-daemon test

# Watch mode
pnpm --filter @generacy-ai/credhelper-daemon test:watch

# Integration tests (requires Docker socket)
# These are automatically skipped if no Docker socket is available
pnpm --filter @generacy-ai/credhelper-daemon test -- --testPathPattern integration
```

## Error Responses

| Status | Code | Meaning |
|--------|------|---------|
| 403 | `DOCKER_ACCESS_DENIED` | Request method+path not in role's allowlist |
| 403 | `DOCKER_NAME_RESOLUTION_FAILED` | Container name lookup failed for name-based rule |
| 403 | (streaming rejection) | `follow=true` on logs endpoint |
| 502 | (upstream error) | Upstream Docker daemon returned an error |

## Troubleshooting

**Proxy socket not created**: Verify the role has `docker` config with allowlist rules and a credential with `docker-socket-proxy` exposure. Check daemon logs for errors.

**All requests return 403**: Check the role's `docker.allow` rules. Remember that paths in rules should be unversioned (e.g., `/containers/json`, not `/v1.41/containers/json`). The proxy strips the version prefix automatically.

**Container name-based rules always deny**: Ensure the container exists and the Docker API can resolve its name. The proxy fails closed when name resolution fails. Check that the upstream Docker daemon is reachable.

**Daemon fails to boot with DOCKER_UPSTREAM_NOT_FOUND**: No Docker socket was found. For DinD: ensure `ENABLE_DIND=true` is set and `/var/run/docker.sock` exists. For DooD: ensure `/var/run/docker-host.sock` is mounted.

**Security warning at boot**: Expected when a role allows `POST /containers/create` and the upstream is the host Docker socket (DooD). This is a security advisory — the proxy still forwards the request if it matches the allowlist.
