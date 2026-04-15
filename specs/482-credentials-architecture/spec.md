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

### 1. JWT structural parsing (no signature verification)

**Clarified**: Device tokens from generacy-cloud are signed with HS256 (symmetric), not an asymmetric algorithm (see [generacy-cloud device-tokens.ts:52](https://github.com/generacy-ai/generacy-cloud/blob/develop/packages/auth/src/device-tokens.ts#L52)). JWKS is inapplicable for symmetric keys. The daemon skips local signature verification and relies on the cloud to validate tokens on every `fetchSecret()` call.

**Trade-off**: The daemon trusts the token it's given (with structural sanity checks) and relies on the cloud to reject invalid tokens on actual use. This is consistent with the "cloud owns the policy layer" decision (architecture plan decision #1). Worst case (bogus token stored): the next fetch gets 401, daemon surfaces `BackendAuthExpiredError`.

Add `jose` as a dependency for JWT *parsing* only (`decodeJwt()`), not full verification:

```
pnpm add jose --filter @generacy-ai/credhelper-daemon
```

Add a parser module:
```typescript
// packages/credhelper-daemon/src/auth/jwt-parser.ts
export interface SessionTokenClaims {
  sub: string;           // user_id
  org_id: string;
  scope: string;         // must be "credhelper"
  iat: number;
  exp: number;
}

export class JwtParser {
  /**
   * Parse JWT structurally (no signature check) and validate claim shape.
   * Rejects tokens with wrong scope, missing required claims, or past expiry.
   * Signature validation is deferred to the cloud on actual use.
   */
  parse(token: string): SessionTokenClaims;
}
```

**Env vars**: Only `GENERACY_CLOUD_API_URL` is needed (where to make resolve calls). No JWKS URL, no issuer URL, no symmetric secret.

### 2. Control server endpoints

Add to [packages/credhelper-daemon/src/control-server.ts](packages/credhelper-daemon/src/control-server.ts):

**`PUT /auth/session-token`**
- Body: `{ token: string }` (JSON)
- SO_PEERCRED restricted to worker uid (existing). `stack secrets login` runs inside the worker container via `docker compose exec worker ...` as the `node` user (uid 1000), matching the expected worker uid.
- Parse JWT structurally (no signature check) via `jose.decodeJwt()`
- Validate claim shape: has `sub`, `org_id`, `scope === "credhelper"`, `exp` not in the past
- On success:
  - Atomically write token to `/run/generacy-credhelper/session-token` (mode 0600). Daemon runs as `credhelper` user (uid 1002, primary group `node` per tetrad-development#59), so ownership follows process uid — no `chown` needed.
  - Atomic write = write to `.tmp` + `rename()`
  - Update in-memory cached claims
- Responses:
  - `204 No Content` on success (no body — don't echo the token)
  - `400 { error, code: "INVALID_TOKEN" | "EXPIRED_TOKEN" | "INVALID_SCOPE" | "MALFORMED_REQUEST" }`

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

**Clarified**: `backendKey` in `credentials.yaml` is the **user-chosen human-readable name** (e.g., `my-stripe-key`, `github-main-org`). Humans edit `credentials.yaml` and review role changes in PRs — opaque Firestore IDs are unacceptable for this workflow.

**Prerequisite**: The cloud resolve endpoint (`POST /api/organizations/:orgId/credentials/:id/resolve`) must accept human-readable names, not just Firestore doc IDs. **Action required**: verify the cloud resolve endpoint accepts names. If it currently only accepts Firestore IDs, file a sub-issue in generacy-cloud to extend the endpoint to accept name-based lookup. If the cloud endpoint cannot be changed quickly, fall back to Firestore doc IDs for v1.5 and revisit.

Document this clearly in the architecture plan: for `backend: generacy-cloud`, `backendKey` is the human-readable credential name as it appears in the org's credential list in generacy-cloud.

### 5. Error message clarity

All auth-related errors should be actionable:
- `BackendAuthRequiredError` → "Run `stack secrets login` inside the worker container"
- `BackendAuthExpiredError` → "Session expired (N hours since `stack secrets login`) — run `stack secrets login` again"
- `BackendSecretNotFoundError` → "Credential `foo` not found in org `bar` — check the org settings page in generacy-cloud"

### 6. Tests

- Unit tests for `JwtParser`: valid token, expired, wrong scope, missing required claims, malformed JWT
- Unit tests for the three new control server endpoints: happy path + each error case
- Unit tests for `GeneracyCloudBackend`: 200, 401, 404, 500, auth-required (no token), auth-expired (401 from API)
- Integration test: start daemon → PUT session token (valid JWT structure with correct claims) → GET status → session begin uses cloud backend → verify HTTP call to mock generacy-cloud with correct Bearer auth → DELETE session token → GET status shows unauthenticated

### 7. Coordination with generacy-cloud

This issue depends on:
- The JWT format/claims from generacy-ai/generacy-cloud#413 (should already be `scope: "credhelper"`, `org_id`, standard RFC 7519 claims)
- ~~The JWKS endpoint — **no longer needed**; daemon uses structural JWT parsing, not signature verification~~
- The resolve endpoint from generacy-ai/generacy-cloud#412 (`POST /api/organizations/:orgId/credentials/:id/resolve`) accepting the device-flow-issued JWT
- **The resolve endpoint accepting human-readable credential names** (not just Firestore doc IDs) — verify and file sub-issue in generacy-cloud if needed

If any of the above aren't in place, file sub-issues in generacy-cloud before this can complete.

## Acceptance criteria

- Three new control server endpoints work end-to-end with structural JWT validation (no signature verification)
- Session token file is written/deleted with correct permissions (mode 0600, owner follows daemon process uid — credhelper:node)
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

### US1: Cloud-backed credential resolution

**As a** developer using generacy workers,
**I want** to authenticate via `stack secrets login` and have cloud-backed credentials automatically resolved,
**So that** my worker containers can access secrets stored in generacy-cloud without manual configuration.

**Acceptance Criteria**:
- [ ] `stack secrets login` delivers JWT to daemon via `PUT /auth/session-token`
- [ ] `GET /auth/session-token/status` shows authenticated state without leaking the token
- [ ] `GeneracyCloudBackend.fetchSecret()` resolves credentials using the stored JWT
- [ ] `DELETE /auth/session-token` clears authentication state

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `PUT /auth/session-token` accepts and structurally validates JWT | P1 | No signature verification — deferred to cloud |
| FR-002 | `DELETE /auth/session-token` clears token file and in-memory state | P1 | Idempotent (ignores ENOENT) |
| FR-003 | `GET /auth/session-token/status` returns auth state without token | P1 | Reads from in-memory cache |
| FR-004 | `GeneracyCloudBackend` fetches secrets from cloud API with Bearer auth | P1 | Depends on #481 backend factory |
| FR-005 | Actionable error messages for auth-required / expired / not-found | P1 | |
| FR-006 | Token file written atomically with mode 0600 | P1 | tmp + rename pattern |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | End-to-end flow | login → fetch → logout works | Integration test |
| SC-002 | Error UX | All auth errors include actionable guidance | Unit test assertions |

## Assumptions

- #481 (Phase 7a) merges first, providing `BackendClient` factory and `GeneracyCloudBackend` stub
- Daemon runs as `credhelper` user (uid 1002, group `node`) per tetrad-development#59
- `stack secrets login` runs inside worker container via `docker compose exec worker ...` as uid 1000
- Device tokens use HS256 signing — no JWKS/asymmetric verification possible
- Cloud resolve endpoint will accept human-readable credential names (verify/file sub-issue)

## Out of Scope

- Local JWT signature verification (HS256 symmetric — cloud validates on use)
- JWKS endpoint integration (not applicable for HS256)
- SO_PEERCRED fix (separate bug — file sibling issue if found broken)
- Generic launcher credential paths (`cli-utils.ts`, `subprocess.ts`) — deferred to follow-up
- Migration to RS256 + JWKS (future improvement, not v1.5)

---

*Generated by speckit*
