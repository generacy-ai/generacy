# Feature Specification: ## Credentials Architecture — Critical Integration Gap (Phase 7b)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `482-credentials-architecture` | **Date**: 2026-04-15 | **Status**: Draft

## Summary

## Credentials Architecture — Critical Integration Gap (Phase 7b)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). Discovered during end-to-end verification after Phase 6 landed.

**Blocks:** `stack secrets login` (from generacy-ai/tetrad-development#65) and ALL generacy-cloud-backed credentials.

**Depends on:** #481 (Phase 7a — backend factory + env backend). This issue replaces the `GeneracyCloudBackend` stub from #481 with a real implementation.

## Problem

Two coupled gaps that together prevent any cloud-backed credential flow from working:

### Gap 1: Session-token endpoints missing on the control server

[packages/credhelper-daemon/src/control-server.ts:102-105](packages/credhelper-daemon/src/control-server.ts#L102-L105) only implements `POST /sessions` and `DELETE /sessions/:id`, explicitly rejecting all other routes with `400 INVALID_REQUEST`.

`stack secrets login` in tetrad-development was implemented to deliver the OIDC-issued JWT to the daemon via `PUT /auth/session-token` (per generacy-ai/tetrad-development#65 Q2: B). That endpoint doesn't exist. The device flow against generacy-cloud succeeds, but token delivery to the daemon fails with HTTP 400.

Missing endpoints:
- `PUT /auth/session-token` — accept + validate + persist the JWT
- `DELETE /auth/session-token` — logout
- `GET /auth/session-token/status` — return `{ user, org, expiresAt }` without leaking the token

### Gap 2: generacy-cloud backend not implemented

[packages/credhelper-daemon/src/](packages/credhelper-daemon/src/) has no `backends/` directory. The `backend: generacy-cloud` declaration in `backends.yaml` is parsed by config loading (#462) but there's no runtime implementation that fetches secrets from generacy-cloud. #481 adds a stub that throws NotImplementedError; this issue replaces it with a working implementation.

## What needs to be done

### 1. JWT verification infrastructure

Add a JWT library as a daemon dependency — recommend `jose` (modern, supports JWKS, widely used). `jsonwebtoken` is also acceptable but has a larger API surface.

```
pnpm add jose --filter @generacy-ai/credhelper-daemon
```

Add a verifier module:
```typescript
// packages/credhelper-daemon/src/auth/jwt-verifier.ts
export interface JwtVerifier {
  verify(token: string): Promise<SessionTokenClaims>;
}

export interface SessionTokenClaims {
  sub: string;           // user_id
  org_id: string;
  scope: string;         // must be "credhelper"
  iat: number;
  exp: number;
  iss: string;           // must match expected issuer
}

export class JoseJwtVerifier implements JwtVerifier {
  // Fetches JWKS from ${GENERACY_CLOUD_API_URL}/.well-known/jwks.json
  // Caches public keys with periodic refresh
  // Verifies signature, expiry, issuer, and scope claim
}
```

The issuer and JWKS URL are derived from `GENERACY_CLOUD_API_URL` env var or a dedicated `GENERACY_CLOUD_ISSUER` / `GENERACY_CLOUD_JWKS_URL` (pick whichever matches what generacy-cloud actually exposes — coordinate with generacy-ai/generacy-cloud#413 author).

### 2. Control server endpoints

Add to [packages/credhelper-daemon/src/control-server.ts](packages/credhelper-daemon/src/control-server.ts):

**`PUT /auth/session-token`**
- Body: `{ token: string }` (JSON)
- SO_PEERCRED still restricted to worker uid (existing)
- Validate JWT: signature, expiry, `scope: "credhelper"` claim
- On success:
  - Atomically write token to `/run/generacy-credhelper/session-token` (mode 0600, owner credhelper:credhelper)
  - Atomic write = write to `.tmp` + `rename()`
  - Update in-memory cached claims
- Responses:
  - `204 No Content` on success (no body — don't echo the token)
  - `400 { error, code: "INVALID_JWT" | "EXPIRED_JWT" | "INVALID_SCOPE" | "MALFORMED_REQUEST" }`
  - `502 { error, code: "JWKS_UNREACHABLE" }` if public keys can't be fetched

**`DELETE /auth/session-token`**
- No body
- Unlink the session token file (ignore ENOENT — idempotent)
- Clear in-memory claims
- Responses:
  - `204 No Content`

**`GET /auth/session-token/status`**
- No body
- Read cached claims (no file read to avoid race)
- Responses:
  - `200 { authenticated: true, user: string, org: string, expiresAt: string }` — never includes the token itself
  - `200 { authenticated: false }` — no token persisted

### 3. `GeneracyCloudBackend` implementation

Replace the #481 stub at `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts`:

```typescript
export class GeneracyCloudBackend implements BackendClient {
  constructor(
    private readonly apiUrl: string,
    private readonly sessionTokenProvider: SessionTokenProvider,
  ) {}

  async fetchSecret(key: string): Promise<string> {
    const token = await this.sessionTokenProvider.getToken();
    if (!token) {
      throw new BackendAuthRequiredError(
        'generacy-cloud backend requires authentication — run `stack secrets login` inside the worker container',
      );
    }

    const response = await fetch(
      `${this.apiUrl}/api/organizations/${token.claims.org_id}/credentials/${encodeURIComponent(key)}/resolve`,
      { method: 'POST', headers: { Authorization: `Bearer ${token.value}` } },
    );

    if (response.status === 401) throw new BackendAuthExpiredError('session expired, run `stack secrets login` again');
    if (response.status === 404) throw new BackendSecretNotFoundError(`credential '${key}' not found in generacy-cloud`);
    if (!response.ok) throw new BackendError(`generacy-cloud returned ${response.status}`);

    const body = await response.json();
    return body.value;  // the decrypted credential value
  }
}
```

The `SessionTokenProvider` reads the token file on demand (or uses in-memory cache) and returns `{ value, claims }` or `null`. It's shared between the control server (writes the token) and the backend (reads it).

### 4. `backendKey` semantics for generacy-cloud

The cloud API uses credential IDs (from Firestore) to identify credentials. The `backendKey` in `credentials.yaml` should be the credential ID as stored in generacy-cloud. Confirm with the UI flow from generacy-ai/generacy-cloud#414 — when a user creates a credential via the UI, they pick a human-readable name; that name (or the generated ID) becomes the `backendKey`.

Document this clearly in the architecture plan: for `backend: generacy-cloud`, `backendKey` is the credential ID / name as it appears in the org's credential list in generacy-cloud.

### 5. Error message clarity

All auth-related errors should be actionable:
- `BackendAuthRequiredError` → "Run `stack secrets login` inside the worker container"
- `BackendAuthExpiredError` → "Session expired (N hours since `stack secrets login`) — run `stack secrets login` again"
- `BackendSecretNotFoundError` → "Credential `foo` not found in org `bar` — check the org settings page in generacy-cloud"

### 6. Tests

- Unit tests for `JoseJwtVerifier`: valid token, expired, wrong scope, wrong issuer, JWKS fetch failure (stubbed network)
- Unit tests for the three new control server endpoints: happy path + each error case
- Unit tests for `GeneracyCloudBackend`: 200, 401, 404, 500, auth-required (no token), auth-expired (401 from API)
- Integration test: start daemon → PUT session token (JWT signed with test key pair) → GET status → session begin uses cloud backend → verify HTTP call to mock generacy-cloud with correct Bearer auth → DELETE session token → GET status shows unauthenticated

### 7. Coordination with generacy-cloud

This issue depends on:
- The JWT format/claims from generacy-ai/generacy-cloud#413 (should already be `scope: "credhelper"`, `org_id`, standard RFC 7519 claims)
- The JWKS endpoint (`/.well-known/jwks.json` or similar) being served by the cloud API — **verify this exists**; if not, file a sub-issue in generacy-cloud
- The resolve endpoint from generacy-ai/generacy-cloud#412 (`POST /api/organizations/:orgId/credentials/:id/resolve`) accepting the device-flow-issued JWT

If any of the above aren't in place, file sub-issues in generacy-cloud before this can complete.

## Acceptance criteria

- Three new control server endpoints work end-to-end with proper JWT verification
- Session token file is written/deleted with correct permissions (0600, credhelper:credhelper)
- Status endpoint never returns the token itself
- `GeneracyCloudBackend` successfully fetches secrets from generacy-cloud when authenticated
- Clear error messages for auth-required / auth-expired / not-found cases
- `backendKey` semantics documented for `backend: generacy-cloud`
- Integration test covers the full login → fetch → logout flow

## Phase grouping

- **Phase 7b** — depends on #481 (Phase 7a)
- After both land, `stack secrets login` works end-to-end and cloud-backed credentials can be resolved

## Related

- generacy-ai/tetrad-development#65 (stack secrets login client already implemented)
- generacy-ai/generacy-cloud#413 (OIDC device flow, JWT issuance)
- generacy-ai/generacy-cloud#412 (credential storage + resolve endpoint)

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
