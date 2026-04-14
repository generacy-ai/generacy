# Data Model: AgentLauncher Credentials Interceptor

## Core Types

### LaunchRequestCredentials (existing — `@generacy-ai/credhelper`)

Already defined in `packages/credhelper/src/types/launch.ts`:

```typescript
interface LaunchRequestCredentials {
  role: string;   // Credhelper role to request (e.g., 'developer')
  uid: number;    // Unix user ID for subprocess (e.g., 1001)
  gid: number;    // Unix group ID for subprocess
}
```

### LaunchRequest (extended)

```typescript
interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
  credentials?: LaunchRequestCredentials;  // NEW — optional credential scoping
}
```

### CredhelperClient Interface

```typescript
interface CredhelperClient {
  beginSession(role: string, sessionId: string): Promise<BeginSessionResult>;
  endSession(sessionId: string): Promise<void>;
}

interface BeginSessionResult {
  sessionDir: string;   // e.g., /run/generacy-credhelper/sessions/worker-7f2a-wf-42-1713052800-x9k2
  expiresAt: Date;      // Session expiry (daemon handles cleanup after this)
}
```

### CredhelperClientOptions

```typescript
interface CredhelperClientOptions {
  socketPath?: string;   // Default: /run/generacy-credhelper/control.sock
  connectTimeout?: number;  // Default: 5000ms
  requestTimeout?: number;  // Default: 30000ms
}
```

## Wire Protocol (HTTP-over-Unix-socket)

### POST /sessions (Begin Session)

Request:
```json
{
  "role": "developer",
  "session_id": "worker-7f2a-wf-pr-review-42-1713052800-x9k2"
}
```

Response (200):
```json
{
  "session_dir": "/run/generacy-credhelper/sessions/worker-7f2a-wf-pr-review-42-1713052800-x9k2",
  "expires_at": "2026-04-13T15:30:00.000Z"
}
```

Error responses follow `CredhelperErrorResponse` from daemon:
```json
{
  "error": "Role not found: developer",
  "code": "ROLE_NOT_FOUND"
}
```

### DELETE /sessions/:id (End Session)

Response (200):
```json
{
  "ok": true
}
```

## Session Environment Variables

Merged into spawn env when credentials are active:

| Variable | Value | Purpose |
|----------|-------|---------|
| `GENERACY_SESSION_DIR` | `<sessionDir>` | Root of session directory |
| `GIT_CONFIG_GLOBAL` | `<sessionDir>/git/config` | Git credential helper config |
| `GOOGLE_APPLICATION_CREDENTIALS` | `<sessionDir>/gcp/external-account.json` | GCP workload identity federation |
| `DOCKER_HOST` | `unix://<sessionDir>/docker.sock` | Docker socket proxy |

## Error Types

```typescript
class CredhelperUnavailableError extends Error {
  readonly socketPath: string;
  readonly cause?: Error;
}

class CredhelperSessionError extends Error {
  readonly code: string;     // Error code from daemon (e.g., 'ROLE_NOT_FOUND')
  readonly role: string;
  readonly sessionId: string;
}
```

## Relationships

```
LaunchRequest
  ├── intent: LaunchIntent          (what to launch — resolved by plugin)
  ├── credentials?: LaunchRequestCredentials  (NEW — credential scoping)
  │     ├── role ──→ credhelper daemon role config
  │     ├── uid  ──→ ProcessFactory spawn options
  │     └── gid  ──→ ProcessFactory spawn options
  └── env ──→ merged with session env vars

CredhelperClient
  ├── beginSession() ──→ POST /sessions (daemon)
  │     └── returns sessionDir, expiresAt
  └── endSession()   ──→ DELETE /sessions/:id (daemon)

LaunchHandle
  └── process.exitPromise ──→ triggers endSession() cleanup
```

## Validation Rules

- `credentials.role`: Non-empty string (validated by daemon against role config)
- `credentials.uid`: Positive integer (Unix UID)
- `credentials.gid`: Positive integer (Unix GID)
- `sessionId`: Composite key matching pattern `{agentId}-{workflowId}-{timestamp}-{random4}`
- `socketPath`: Valid Unix socket path (existence checked at connect time)
