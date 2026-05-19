# Research: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

## Technology Decisions

### 1. JWT Library: `jose`

**Decision**: Use `jose` for structural JWT parsing only (`decodeJwt()`).

**Rationale**:
- `jose` is the modern standard for JWT handling in Node.js — maintained by Panva, ESM-native, zero dependencies
- Only need `decodeJwt()` (base64url decode + JSON parse) — no signature verification
- Alternative `jsonwebtoken` considered and rejected: CommonJS-only, larger API surface, would need to be ESM-wrapped
- Alternative "manual decode" considered and rejected: error-prone for edge cases (padding, malformed segments), `jose` handles these correctly

**Usage**: Import `{ decodeJwt }` from `jose`. No JWKS, no `jwtVerify()`, no key management.

### 2. JWT Verification Strategy: Structural Only

**Decision**: Skip local signature verification. Parse JWT structurally and validate claim shape. Defer signature validation to generacy-cloud on every `fetchSecret()` call.

**Rationale**:
- Device tokens from generacy-cloud use HS256 (symmetric signing) — see [generacy-cloud device-tokens.ts:52](https://github.com/generacy-ai/generacy-cloud/blob/develop/packages/auth/src/device-tokens.ts#L52)
- JWKS is inapplicable for symmetric keys (JWKS serves asymmetric public keys)
- Sharing the HS256 secret with the daemon would violate the "cloud owns the policy layer" architecture decision
- Trade-off: a tampered token gets stored but immediately fails on first `fetchSecret()` (401 → `BackendAuthExpiredError`)
- Future: if generacy-cloud migrates to RS256 (asymmetric), this can be upgraded to full JWKS verification without changing the endpoint contract

**Claim Validation (structural)**:
| Claim | Validation | Error Code |
|-------|-----------|------------|
| `sub` | Must be present (non-empty string) | `INVALID_TOKEN` |
| `org_id` | Must be present (non-empty string) | `INVALID_TOKEN` |
| `scope` | Must equal `"credhelper"` | `INVALID_SCOPE` |
| `exp` | Must be present, must be > `Date.now()/1000` | `EXPIRED_TOKEN` |
| `iat` | Must be present | `INVALID_TOKEN` |

### 3. Token Storage: In-Memory + Filesystem

**Decision**: Dual storage — in-memory cache as primary, filesystem as persistence across daemon restarts.

**Rationale**:
- In-memory cache avoids filesystem I/O on every `fetchSecret()` call
- Filesystem persistence (`/run/generacy-credhelper/session-token`) allows token survival across daemon restarts within a container lifecycle
- `/run/` is a tmpfs mount — tokens don't survive container recreation (desirable — forces re-login)
- Atomic write (`.tmp` + `rename()`) prevents partial reads if daemon crashes mid-write
- Mode 0600 restricts access to daemon process owner (credhelper user, uid 1002)

**Alternatives Considered**:
- Memory-only: loses token on daemon restart (user must re-login) — rejected for UX
- File-only: filesystem I/O on every fetch — rejected for performance
- SQLite: overkill for a single key-value pair — rejected

### 4. Error Strategy: Actionable Messages

**Decision**: All auth-related errors include specific remediation steps.

**Error Hierarchy**:
| Error | HTTP Status | Message Pattern |
|-------|------------|-----------------|
| `BackendAuthRequiredError` | 502 | "generacy-cloud backend requires authentication — run `stack secrets login` inside the worker container" |
| `BackendAuthExpiredError` | 502 | "session expired, run `stack secrets login` again" |
| `BackendSecretNotFoundError` | 502 | "credential '{key}' not found in generacy-cloud" |
| `INVALID_TOKEN` | 400 | "JWT is malformed or missing required claims (sub, org_id, scope, exp, iat)" |
| `EXPIRED_TOKEN` | 400 | "JWT has expired (exp: {exp})" |
| `INVALID_SCOPE` | 400 | "JWT scope must be 'credhelper', got '{actual}'" |

### 5. Control Server Endpoint Design

**Decision**: REST-style endpoints under `/auth/session-token` prefix.

**Route Design**:
| Method | Path | Purpose | Response |
|--------|------|---------|----------|
| `PUT` | `/auth/session-token` | Store JWT | `204 No Content` |
| `DELETE` | `/auth/session-token` | Clear JWT | `204 No Content` |
| `GET` | `/auth/session-token/status` | Check auth state | `200 { authenticated, user?, org?, expiresAt? }` |

**Why PUT (not POST)**:
- PUT is idempotent — calling it twice with the same token is safe
- There's exactly one session token slot (not a collection) — PUT replaces the resource
- Matches the client implementation in `stack secrets login` (tetrad-development#65)

**Why `/status` sub-path (not just GET on `/auth/session-token`)**:
- GET on the token resource itself would imply returning the token (security risk)
- `/status` makes it explicit that this returns metadata, not the credential

### 6. Backend `fetchSecret()` API Contract

**Decision**: `POST /api/organizations/:orgId/credentials/:key/resolve` with Bearer auth.

**Request**:
```
POST /api/organizations/{org_id_from_jwt}/credentials/{backendKey}/resolve
Authorization: Bearer {stored_jwt}
```

**Response mapping**:
| Cloud Status | Daemon Behavior |
|-------------|-----------------|
| `200 { value }` | Return `value` to plugin |
| `401` | Throw `BackendAuthExpiredError` |
| `404` | Throw `BackendSecretNotFoundError` |
| Other non-2xx | Throw `BackendError` with status code |

**`backendKey` format**: Human-readable credential name (e.g., `my-stripe-key`), not Firestore doc ID. Prerequisite: cloud resolve endpoint must accept names — verify with generacy-cloud team.

## Implementation Patterns

### Atomic File Write Pattern

```typescript
import { writeFile, rename, unlink } from 'node:fs/promises';

async function atomicWrite(filePath: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, { mode });
  await rename(tmpPath, filePath);
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
```

### SessionTokenStore as Shared Dependency

```
bin/credhelper-daemon.ts
  └── creates SessionTokenStore(tokenFilePath)
        ├── injected into ControlServer (PUT/DELETE/GET handlers)
        └── injected into BackendClientFactory
              └── passed to GeneracyCloudBackend constructor
```

Single instance, shared via DaemonConfig. ControlServer writes; GeneracyCloudBackend reads.

## Key Sources / References

- [generacy-cloud device-tokens.ts](https://github.com/generacy-ai/generacy-cloud/blob/develop/packages/auth/src/device-tokens.ts) — HS256 signing, claim shape
- [jose library](https://github.com/panva/jose) — JWT parsing, `decodeJwt()` API
- generacy-ai/tetrad-development#65 — `stack secrets login` client (sends `PUT /auth/session-token`)
- generacy-ai/generacy-cloud#412 — credential storage + resolve endpoint
- generacy-ai/generacy-cloud#413 — OIDC device flow, JWT issuance
- [credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — overall architecture
