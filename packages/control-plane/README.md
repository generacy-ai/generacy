# @generacy-ai/control-plane

In-cluster HTTP service over Unix socket for the cloud-hosted bootstrap UI. Terminates control-plane requests forwarded by the cluster-relay dispatcher.

## Socket Path

Default: `/run/generacy-control-plane/control.sock`

Override via `CONTROL_PLANE_SOCKET_PATH` environment variable.

Socket is created with mode `0660` (owner + group read/write).

## Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/state` | Returns cluster status, deployment mode, variant, last-seen timestamp |
| GET | `/credentials/:id` | Returns stub credential entry |
| PUT | `/credentials/:id` | Accepts credential update, returns `{ ok: true }` |
| GET | `/roles/:id` | Returns stub role config |
| PUT | `/roles/:id` | Accepts role update, returns `{ ok: true }` |
| POST | `/lifecycle/:action` | Triggers lifecycle action (`clone-peer-repos`, `code-server-start`, `code-server-stop`) |

All routes are stubs in this phase. Real wiring to credhelper daemon and orchestrator lands in later phases.

## Actor Headers

The relay dispatcher injects identity headers on every forwarded request:

- `x-generacy-actor-user-id` — authenticated user ID
- `x-generacy-actor-session-id` — relay session ID

These are extracted into an `ActorContext` and available to all route handlers.

## Error Shape

All errors follow the credhelper-daemon convention:

```json
{
  "error": "Human-readable message",
  "code": "ERROR_CODE",
  "details": {}
}
```

Error codes: `INVALID_REQUEST` (400), `NOT_FOUND` (404), `UNKNOWN_ACTION` (400), `SERVICE_UNAVAILABLE` (503), `INTERNAL_ERROR` (500).

## Orchestrator Integration

The orchestrator container's entrypoint spawns this service as a sub-process:

1. Start the control-plane binary: `node dist/bin/control-plane.js`
2. The service binds the Unix socket and logs readiness
3. If the service crashes, the orchestrator continues running
4. The relay dispatcher returns 503 from the socket prefix if the socket is unavailable

Crash tolerance is by design — failures must not block orchestrator boot.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
