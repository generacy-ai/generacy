# Quickstart: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

## Prerequisites

- #481 (Phase 7a) must be merged first — provides `BackendClientFactory`, `EnvBackend`, and `GeneracyCloudBackend` stub
- Node.js ≥20
- `pnpm` installed
- Development stack running (for integration testing)

## Setup

```bash
# From repo root
cd /workspaces/generacy

# Rebase on develop after #481 merges
git checkout 482-credentials-architecture
git rebase develop

# Install dependencies (jose will be added)
pnpm install

# Add jose to credhelper-daemon
pnpm add jose --filter @generacy-ai/credhelper-daemon
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GENERACY_CLOUD_API_URL` | For cloud backend | none | Base URL for generacy-cloud API (e.g., `https://api.generacy.ai`) |
| `CREDHELPER_CONTROL_SOCKET` | No | `/run/generacy-credhelper/control.sock` | Control socket path |
| `CREDHELPER_SESSIONS_DIR` | No | `/run/generacy-credhelper/sessions` | Session directory |
| `CREDHELPER_WORKER_UID` | No | `1000` | Expected worker uid for SO_PEERCRED |
| `CREDHELPER_AGENCY_DIR` | No | `${PWD}/.agency` | Agency config directory |

## Running Tests

```bash
# Unit tests only
pnpm --filter @generacy-ai/credhelper-daemon test

# Specific test files
pnpm --filter @generacy-ai/credhelper-daemon vitest run __tests__/auth/jwt-parser.test.ts
pnpm --filter @generacy-ai/credhelper-daemon vitest run __tests__/auth/session-token-store.test.ts
pnpm --filter @generacy-ai/credhelper-daemon vitest run __tests__/control-server.test.ts
pnpm --filter @generacy-ai/credhelper-daemon vitest run __tests__/backends/generacy-cloud-backend.test.ts

# Integration test
pnpm --filter @generacy-ai/credhelper-daemon vitest run __tests__/integration/session-token-flow.test.ts
```

## API Usage

### Authenticate (deliver JWT from `stack secrets login`)

```bash
# PUT /auth/session-token
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X PUT \
  -H 'Content-Type: application/json' \
  -d '{"token": "eyJhbGciOiJIUzI1NiJ9..."}' \
  http://localhost/auth/session-token

# Response: 204 No Content
```

### Check auth status

```bash
# GET /auth/session-token/status
curl --unix-socket /run/generacy-credhelper/control.sock \
  http://localhost/auth/session-token/status

# Response (authenticated):
# {"authenticated": true, "user": "user_abc123", "org": "org_xyz", "expiresAt": "2026-04-16T12:00:00.000Z"}

# Response (not authenticated):
# {"authenticated": false}
```

### Logout (clear session token)

```bash
# DELETE /auth/session-token
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X DELETE \
  http://localhost/auth/session-token

# Response: 204 No Content
```

### Existing endpoints (unchanged)

```bash
# Begin credential session
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{"role": "ci-deploy", "session_id": "sess-001"}' \
  http://localhost/sessions

# End credential session
curl --unix-socket /run/generacy-credhelper/control.sock \
  -X DELETE \
  http://localhost/sessions/sess-001
```

## End-to-End Flow

1. Start development stack: `/workspaces/tetrad-development/scripts/stack start`
2. Source env: `source /workspaces/tetrad-development/scripts/stack-env.sh`
3. Login: `stack secrets login` (inside worker container)
4. Verify: `curl --unix-socket ... http://localhost/auth/session-token/status`
5. Begin session with cloud-backed credentials: `POST /sessions` with a role that uses `backend: generacy-cloud`
6. Credential plugins call `fetchSecret()` → `GeneracyCloudBackend` → cloud API
7. Logout: `stack secrets login --logout` (calls `DELETE /auth/session-token`)

## Error Codes (new)

| Code | HTTP | Cause | Remediation |
|------|------|-------|-------------|
| `INVALID_TOKEN` | 400 | JWT malformed or missing claims | Check token format from `stack secrets login` |
| `EXPIRED_TOKEN` | 400 | JWT `exp` in the past | Run `stack secrets login` again |
| `INVALID_SCOPE` | 400 | JWT scope isn't "credhelper" | Ensure generacy-cloud issues tokens with `scope: "credhelper"` |
| `MALFORMED_REQUEST` | 400 | Missing `{ token }` body on PUT | Include JSON body with `token` field |
| `BACKEND_AUTH_REQUIRED` | 502 | No session token stored | Run `stack secrets login` inside the worker container |
| `BACKEND_AUTH_EXPIRED` | 502 | Cloud returned 401 | Session expired — run `stack secrets login` again |

## Troubleshooting

**"INVALID_TOKEN" on PUT**: The JWT from `stack secrets login` is malformed. Check the device flow in generacy-cloud is completing successfully and returning a valid JWT.

**"BACKEND_AUTH_REQUIRED" on session begin**: No one has run `stack secrets login` in this container lifecycle. The cloud backend needs a JWT to authenticate API calls.

**"BACKEND_AUTH_EXPIRED" on credential fetch**: The JWT has expired server-side (cloud rejected it with 401). Re-run `stack secrets login`.

**Token persists after container restart**: The token file lives at `/run/generacy-credhelper/session-token` which is on tmpfs. It survives daemon restarts within a container lifecycle but is cleared on container recreation.
