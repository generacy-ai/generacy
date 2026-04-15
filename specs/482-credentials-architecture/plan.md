# Implementation Plan: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

**Feature**: Add session-token auth endpoints to daemon control server and implement generacy-cloud backend
**Branch**: `482-credentials-architecture`
**Status**: Complete

## Summary

The credhelper daemon currently lacks endpoints for receiving JWTs from `stack secrets login` and has no working `generacy-cloud` backend. This plan adds three `/auth/session-token` endpoints to the control server (PUT, DELETE, GET), a JWT structural parser (no signature verification — HS256 precludes JWKS), a shared `SessionTokenStore` for in-memory + filesystem token management, and replaces the Phase 7a `GeneracyCloudBackend` stub with a real implementation that fetches secrets from the generacy-cloud API using Bearer auth.

**Dependency**: Blocks on #481 (Phase 7a — PR #483) merging first. Phase 7a provides the `BackendClientFactory`, `EnvBackend`, and the `GeneracyCloudBackend` stub that this issue replaces.

## Technical Context

**Language/Version**: TypeScript 5.4+ (ESM, Node.js ≥20)
**Package**: `packages/credhelper-daemon` (runtime daemon)
**Shared types**: `packages/credhelper` (types-only, Zod schemas — **read-only for this issue**)
**New dependency**: `jose` (JWT structural parsing via `decodeJwt()` — no signature verification)
**Testing**: Vitest (existing test patterns: mock SessionManager, temp Unix sockets, `createMockConfigLoader()`)
**Target Platform**: Linux (worker containers, Docker Compose stack)
**Constraints**: HS256 tokens (symmetric) — no JWKS/asymmetric verification possible. Cloud validates tokens on use.

## Project Structure

### Documentation (this feature)

```text
specs/482-credentials-architecture/
├── spec.md              # Feature specification
├── clarifications.md    # Clarified questions
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Types, interfaces, validation rules
└── quickstart.md        # Dev guide
```

### New Files

```text
packages/credhelper-daemon/
├── src/
│   ├── auth/
│   │   ├── jwt-parser.ts              # Structural JWT parsing (jose.decodeJwt)
│   │   └── session-token-store.ts     # In-memory + filesystem token provider
│   └── backends/
│       └── generacy-cloud-backend.ts  # REPLACE Phase 7a stub with real implementation
├── __tests__/
│   ├── auth/
│   │   ├── jwt-parser.test.ts
│   │   └── session-token-store.test.ts
│   ├── backends/
│   │   └── generacy-cloud-backend.test.ts  # REPLACE stub tests
│   └── integration/
│       └── session-token-flow.test.ts      # End-to-end: login → fetch → logout
```

### Modified Files

```text
packages/credhelper-daemon/
├── src/
│   ├── control-server.ts     # Add 3 /auth/session-token routes
│   ├── errors.ts             # Add auth-related error codes
│   ├── daemon.ts             # Wire SessionTokenStore + pass to ControlServer & factory
│   ├── types.ts              # Add SessionTokenStore to DaemonConfig
│   └── backends/
│       └── factory.ts        # Update generacy-cloud case to use real backend
├── bin/
│   └── credhelper-daemon.ts  # Read GENERACY_CLOUD_API_URL, create SessionTokenStore
├── __tests__/
│   └── control-server.test.ts  # Add tests for 3 new routes
├── package.json              # Add jose dependency
```

**Structure Decision**: All new code lives within the existing `packages/credhelper-daemon` package. The `auth/` subdirectory is new and groups JWT parsing + token storage. The `backends/` subdirectory was created by Phase 7a (#481); this issue replaces the stub file within it.

## Implementation Phases

### Phase A: Foundation (auth infrastructure)

1. **Add `jose` dependency** — `pnpm add jose --filter @generacy-ai/credhelper-daemon`
2. **Create `src/auth/jwt-parser.ts`** — `JwtParser` class with `parse(token: string): SessionTokenClaims`
   - Uses `jose.decodeJwt()` for structural parsing (no signature check)
   - Validates: `sub` present, `org_id` present, `scope === "credhelper"`, `exp` not in past
   - Throws typed errors: `INVALID_TOKEN`, `EXPIRED_TOKEN`, `INVALID_SCOPE`
3. **Create `src/auth/session-token-store.ts`** — `SessionTokenStore` class
   - In-memory cache of `{ value: string, claims: SessionTokenClaims }` or `null`
   - `setToken(token: string)`: parse JWT, atomic write to filesystem, update cache
   - `clearToken()`: unlink file (ignore ENOENT), clear cache
   - `getStatus()`: return claims without token value, or `{ authenticated: false }`
   - `getToken()`: return `{ value, claims }` or `null` (used by backend)
   - Atomic write: write to `.tmp` file + `rename()`, mode 0600

### Phase B: Control server endpoints

4. **Extend `src/errors.ts`** — Add error codes: `INVALID_TOKEN`, `EXPIRED_TOKEN`, `INVALID_SCOPE`, `MALFORMED_REQUEST`, `BACKEND_AUTH_REQUIRED`, `BACKEND_AUTH_EXPIRED`
5. **Modify `src/control-server.ts`** — Add 3 routes:
   - `PUT /auth/session-token` → validate JWT, store token, respond 204
   - `DELETE /auth/session-token` → clear token, respond 204
   - `GET /auth/session-token/status` → return auth status (no token leakage)
   - `ControlServer` constructor gains `SessionTokenStore` parameter

### Phase C: Generacy-cloud backend

6. **Replace `src/backends/generacy-cloud-backend.ts`** — Real implementation:
   - Constructor: `apiUrl: string`, `sessionTokenProvider: SessionTokenStore`
   - `fetchSecret(key)`: read token from store, call `POST /api/organizations/:orgId/credentials/:key/resolve` with Bearer auth
   - Error mapping: 401 → `BackendAuthExpiredError`, 404 → `BackendSecretNotFoundError`, no token → `BackendAuthRequiredError`
7. **Update `src/backends/factory.ts`** — `generacy-cloud` case creates real `GeneracyCloudBackend` with apiUrl + sessionTokenStore

### Phase D: Wiring & entry point

8. **Modify `src/types.ts`** — Add `sessionTokenStore` and `generacyCloudApiUrl` to `DaemonConfig`
9. **Modify `src/daemon.ts`** — Pass `SessionTokenStore` to `ControlServer` and make it available for factory
10. **Modify `bin/credhelper-daemon.ts`** — Read `GENERACY_CLOUD_API_URL` env var, create `SessionTokenStore` with token file path, pass to `DaemonConfig`

### Phase E: Tests

11. **Unit tests**: `jwt-parser.test.ts`, `session-token-store.test.ts`, `generacy-cloud-backend.test.ts`
12. **Extended unit tests**: `control-server.test.ts` (3 new endpoint groups)
13. **Integration test**: `session-token-flow.test.ts` — full login → status → fetch → logout → status cycle

## Key Design Decisions

1. **No signature verification** — HS256 tokens cannot be verified without the shared secret (which the daemon doesn't have). Cloud validates on every `fetchSecret()` call.
2. **Structural parsing only** — `jose.decodeJwt()` parses the JWT structure and extracts claims. Validation is limited to claim shape and expiry.
3. **Shared SessionTokenStore** — Single instance shared between ControlServer (writes) and GeneracyCloudBackend (reads). In-memory cache avoids filesystem races.
4. **Atomic file writes** — Token file written via temp file + rename to prevent partial reads.
5. **Cloud validates on use** — Worst case with a bogus token: the next `fetchSecret()` gets 401, which surfaces as `BackendAuthExpiredError` with actionable guidance.
6. **backendKey = human-readable name** — `backendKey` in `credentials.yaml` is the user-chosen credential name, not a Firestore doc ID.

## Risk & Coordination

| Risk | Mitigation |
|------|------------|
| #481 PR not merged yet | Block — rebase after merge, no parallel implementation |
| Cloud resolve endpoint doesn't accept human-readable names | Fall back to Firestore doc IDs; file sub-issue in generacy-cloud |
| Cloud JWT claims don't include `org_id` or `scope` | Coordinate with generacy-cloud#413 author; adjust parser if needed |
| SO_PEERCRED broken for auth endpoints | Known limitation — DAC-only fallback protects via socket file permissions |
