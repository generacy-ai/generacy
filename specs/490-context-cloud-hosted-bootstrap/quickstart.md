# Quickstart: @generacy-ai/control-plane

## Installation

```bash
# From workspace root
pnpm install
pnpm --filter @generacy-ai/control-plane build
```

## Running the Service

```bash
# Default socket path: /run/generacy-control-plane/control.sock
pnpm --filter @generacy-ai/control-plane start

# Custom socket path
CONTROL_PLANE_SOCKET_PATH=/tmp/control.sock pnpm --filter @generacy-ai/control-plane start
```

## Testing

```bash
# Unit + integration tests
pnpm --filter @generacy-ai/control-plane test

# Watch mode
pnpm --filter @generacy-ai/control-plane test:watch
```

## API Endpoints

All endpoints are accessed over the Unix socket. Use `curl --unix-socket` for manual testing.

### GET /state
Returns cluster status.
```bash
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/state
# → { "status": "ready", "deploymentMode": "local", "variant": "cluster-base", "lastSeen": "..." }
```

### GET /credentials/:id
Returns credential entry (stub).
```bash
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/credentials/github-token
# → { "id": "github-token", "type": "github-pat", "backend": "env", "backendKey": "GITHUB_TOKEN", "status": "active", "createdAt": "..." }
```

### PUT /credentials/:id
Updates credential entry (stub).
```bash
curl -X PUT --unix-socket /run/generacy-control-plane/control.sock \
  -H "Content-Type: application/json" \
  -d '{"type":"github-pat","backend":"env","backendKey":"GITHUB_TOKEN"}' \
  http://localhost/credentials/github-token
# → { "ok": true }
```

### GET /roles/:id
Returns role configuration (stub).
```bash
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/roles/ci-runner
# → { "id": "ci-runner", "description": "CI runner role", "credentials": [...] }
```

### PUT /roles/:id
Updates role configuration (stub).
```bash
curl -X PUT --unix-socket /run/generacy-control-plane/control.sock \
  -H "Content-Type: application/json" \
  -d '{"description":"Updated role","credentials":[]}' \
  http://localhost/roles/ci-runner
# → { "ok": true }
```

### POST /lifecycle/:action
Triggers a lifecycle action (stub).
```bash
curl -X POST --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/lifecycle/clone-peer-repos
# → { "accepted": true, "action": "clone-peer-repos" }
```

Valid actions: `clone-peer-repos`, `code-server-start`, `code-server-stop`.

### Error Responses
All errors return a structured JSON body:
```json
{ "error": "Not found: GET /unknown", "code": "NOT_FOUND" }
```

## Actor Headers

The relay dispatcher injects actor identity headers. These are available on the request context:
- `x-generacy-actor-user-id` — Cloud-side user ID
- `x-generacy-actor-session-id` — Cloud-side session ID

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `EADDRINUSE` on socket path | Stale socket file from previous run | Service auto-cleans stale sockets; if persistent, `rm /run/generacy-control-plane/control.sock` |
| `EACCES` on socket path | Wrong permissions on `/run/generacy-control-plane/` | Ensure directory exists and is owned by the `node` user |
| 503 from relay | Control-plane service not running | Check service logs; orchestrator should have spawned it |
| Routes return stubs | Expected behavior in phase 1 | Real wiring lands in later phases |
