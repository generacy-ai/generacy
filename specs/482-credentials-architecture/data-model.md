# Data Model: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

## New Entities

### SessionTokenClaims

```typescript
// packages/credhelper-daemon/src/auth/jwt-parser.ts

export interface SessionTokenClaims {
  sub: string;       // user_id from generacy-cloud
  org_id: string;    // organization ID
  scope: string;     // must be "credhelper"
  iat: number;       // issued-at (Unix seconds)
  exp: number;       // expiry (Unix seconds)
}
```

Extracted from JWT payload via `jose.decodeJwt()`. No signature verification — structural validation only.

### JwtParser

```typescript
// packages/credhelper-daemon/src/auth/jwt-parser.ts

export class JwtParser {
  /**
   * Parse JWT structurally (no signature check) and validate claim shape.
   * Rejects tokens with wrong scope, missing required claims, or past expiry.
   */
  parse(token: string): SessionTokenClaims;
}
```

Stateless, no constructor dependencies. Throws `CredhelperError` with codes:
- `INVALID_TOKEN` — malformed JWT, missing claims
- `EXPIRED_TOKEN` — `exp` in the past
- `INVALID_SCOPE` — `scope !== "credhelper"`

### SessionTokenStore

```typescript
// packages/credhelper-daemon/src/auth/session-token-store.ts

export interface SessionTokenProvider {
  getToken(): Promise<{ value: string; claims: SessionTokenClaims } | null>;
}

export class SessionTokenStore implements SessionTokenProvider {
  constructor(
    private readonly tokenFilePath: string,
    private readonly parser: JwtParser,
  );

  /** Parse JWT, write atomically to filesystem, update in-memory cache. */
  async setToken(token: string): Promise<void>;

  /** Unlink token file (idempotent), clear in-memory cache. */
  async clearToken(): Promise<void>;

  /** Return auth status from in-memory cache (no token value). */
  getStatus(): SessionTokenStatus;

  /** Return token + claims for backend use, or null if not authenticated. */
  async getToken(): Promise<{ value: string; claims: SessionTokenClaims } | null>;

  /** Attempt to load token from filesystem into memory (called at daemon startup). */
  async loadFromDisk(): Promise<void>;
}

export type SessionTokenStatus =
  | { authenticated: true; user: string; org: string; expiresAt: string }
  | { authenticated: false };
```

**Lifecycle**:
1. Created at daemon startup with token file path
2. Calls `loadFromDisk()` to restore token from previous daemon run (if any)
3. `ControlServer` calls `setToken()` / `clearToken()` on PUT/DELETE
4. `GeneracyCloudBackend` calls `getToken()` on every `fetchSecret()`
5. `ControlServer` calls `getStatus()` on GET

### GeneracyCloudBackend (replaces Phase 7a stub)

```typescript
// packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts
import type { BackendClient } from '@generacy-ai/credhelper';

export class GeneracyCloudBackend implements BackendClient {
  constructor(
    private readonly apiUrl: string,
    private readonly sessionTokenProvider: SessionTokenProvider,
  );

  async fetchSecret(key: string): Promise<string>;
}
```

**`fetchSecret()` flow**:
1. Call `sessionTokenProvider.getToken()`
2. If null → throw `BackendAuthRequiredError`
3. `POST ${apiUrl}/api/organizations/${claims.org_id}/credentials/${encodeURIComponent(key)}/resolve`
4. Add `Authorization: Bearer ${token.value}` header
5. Map response: 200 → return `body.value`, 401 → `BackendAuthExpiredError`, 404 → `BackendSecretNotFoundError`, other → `BackendError`

## New Error Types

```typescript
// packages/credhelper-daemon/src/errors.ts — additions to ErrorCode union

export type ErrorCode =
  | // ... existing codes ...
  | 'INVALID_TOKEN'           // 400 — JWT malformed or missing claims
  | 'EXPIRED_TOKEN'           // 400 — JWT exp in the past
  | 'INVALID_SCOPE'           // 400 — JWT scope !== "credhelper"
  | 'MALFORMED_REQUEST'       // 400 — missing/invalid request body
  | 'BACKEND_AUTH_REQUIRED'   // 502 — no session token stored
  | 'BACKEND_AUTH_EXPIRED';   // 502 — cloud returned 401
```

**HTTP Status Map additions**:
```typescript
INVALID_TOKEN: 400,
EXPIRED_TOKEN: 400,
INVALID_SCOPE: 400,
MALFORMED_REQUEST: 400,
BACKEND_AUTH_REQUIRED: 502,
BACKEND_AUTH_EXPIRED: 502,
```

## Modified Entities

### DaemonConfig (add fields)

```typescript
// packages/credhelper-daemon/src/types.ts — additions

export interface DaemonConfig {
  // ... existing fields ...
  sessionTokenStore: SessionTokenStore;      // NEW — shared token provider
  generacyCloudApiUrl?: string;              // NEW — GENERACY_CLOUD_API_URL env var
}
```

### ControlServer (add dependency)

```typescript
// packages/credhelper-daemon/src/control-server.ts — constructor change

export class ControlServer {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly workerUid: number,
    private readonly enablePeerCred: boolean,
    private readonly sessionTokenStore: SessionTokenStore,  // NEW
  );
}
```

### BackendClientFactory (update generacy-cloud case)

```typescript
// packages/credhelper-daemon/src/backends/factory.ts — modified case

// Before (Phase 7a stub):
case 'generacy-cloud':
  return new GeneracyCloudBackend();  // throws NOT_IMPLEMENTED

// After (Phase 7b):
case 'generacy-cloud':
  if (!this.apiUrl) throw new CredhelperError('BACKEND_UNREACHABLE', '...');
  return new GeneracyCloudBackend(this.apiUrl, this.sessionTokenStore);
```

Factory gains constructor parameters: `apiUrl?: string`, `sessionTokenStore: SessionTokenStore`.

## Relationships

```
stack secrets login (client)
  │
  ▼ PUT /auth/session-token { token: "eyJ..." }
ControlServer
  │
  ▼ setToken(jwt)
SessionTokenStore ◄──── loadFromDisk() (startup)
  │ (in-memory cache + /run/.../session-token file)
  │
  ├── getStatus() ◄── GET /auth/session-token/status
  ├── clearToken() ◄── DELETE /auth/session-token
  │
  ▼ getToken()
GeneracyCloudBackend
  │
  ▼ POST /api/organizations/:orgId/credentials/:key/resolve
generacy-cloud API
  │
  ▼ { value: "decrypted-secret" }
Plugin.mint() / Plugin.resolve()
```

## Validation Rules

| Rule | Location | Behavior |
|------|----------|----------|
| JWT structurally valid | `JwtParser.parse()` | Throws `INVALID_TOKEN` |
| JWT has required claims | `JwtParser.parse()` | Throws `INVALID_TOKEN` |
| JWT scope is "credhelper" | `JwtParser.parse()` | Throws `INVALID_SCOPE` |
| JWT not expired | `JwtParser.parse()` | Throws `EXPIRED_TOKEN` |
| Token file mode 0600 | `SessionTokenStore.setToken()` | Set via `writeFile()` mode option |
| Atomic write | `SessionTokenStore.setToken()` | `.tmp` + `rename()` pattern |
| Idempotent delete | `SessionTokenStore.clearToken()` | Ignore ENOENT on unlink |
| Status never leaks token | `SessionTokenStore.getStatus()` | Returns user/org/expiresAt only |
| Auth required for cloud fetch | `GeneracyCloudBackend.fetchSecret()` | Throws `BACKEND_AUTH_REQUIRED` |
| Cloud 401 → expired | `GeneracyCloudBackend.fetchSecret()` | Throws `BACKEND_AUTH_EXPIRED` |
| Cloud 404 → not found | `GeneracyCloudBackend.fetchSecret()` | Throws `BACKEND_SECRET_NOT_FOUND` (existing code) |

## Token File Layout

```
/run/generacy-credhelper/
├── control.sock           # Existing — control server socket
├── session-token          # NEW — persisted JWT (mode 0600)
├── session-token.tmp      # Transient — atomic write temp file
└── sessions/              # Existing — per-session directories
```
