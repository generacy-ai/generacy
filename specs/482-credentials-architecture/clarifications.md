# Clarifications: Session-Token Endpoints & Generacy-Cloud Backend (Phase 7b)

## Batch 1 — 2026-04-15

### Q1: Phase 7a Dependency Status
**Context**: The spec depends on #481 (Phase 7a — backend factory + env backend) to provide the `BackendClient` factory, `backends/` directory structure, and a `GeneracyCloudBackend` stub. Currently PR #483 for #481 is still open and the codebase has none of these artifacts — `session-manager.ts` still uses inline stubs (`{ fetchSecret: async () => '' }`).
**Question**: Should #482 block on #481 merging first, or should it also create the backend factory/registry infrastructure (effectively absorbing that part of #481's scope)?
**Options**:
- A: Block — wait for #481 to merge, then implement #482 against its interfaces
- B: Absorb — implement the backend factory + `GeneracyCloudBackend` together in #482, coordinate with #481 to avoid conflicts
- C: Parallel — implement #482 against the *expected* #481 interfaces (from its PR branch), rebase after merge

**Answer**: A — Block on #481 merging first, then implement #482 against its interfaces. The factory + backend registry + stub belong in #481's scope. Queue #482 after #481's PR #483 merges. Rebase if develop has moved.

### Q2: Auth Endpoint Access Control
**Context**: The spec says "SO_PEERCRED still restricted to worker uid (existing)" for `PUT /auth/session-token`. However, `stack secrets login` (tetrad-development#65) runs as the developer outside the worker container (or with a different uid). The current `peer-cred.ts` implementation returns `null` for SO_PEERCRED and falls back to filesystem DAC (directory permissions on the socket path). The auth endpoints need to be callable by `stack secrets login` which runs with a different identity than the worker processes.
**Question**: Should the `/auth/*` endpoints bypass the worker uid restriction to allow `stack secrets login` to deliver the JWT, or does the login client connect to the socket with the worker uid somehow?
**Options**:
- A: Auth endpoints bypass uid check — any process with filesystem access to the control socket can call `/auth/*`
- B: `stack secrets login` is expected to run as the same uid (e.g., inside the container)
- C: Add a separate "admin uid" allowlist for auth-management endpoints

**Answer**: B — `stack secrets login` runs as the worker uid (inside the container). This matches the design from tetrad-development#65 — `stack secrets login` shells into the worker container via `docker compose exec worker ...`, running as the `node` user (uid 1000). The `/auth/session-token` endpoints keep the existing SO_PEERCRED restriction to worker uid. If SO_PEERCRED is found broken, file a sibling fix issue and continue against filesystem-DAC behavior.

### Q3: JWKS URL Configuration Pattern
**Context**: The spec offers three env var approaches for the JWT verification infrastructure: (1) derive JWKS URL as `${GENERACY_CLOUD_API_URL}/.well-known/jwks.json`, (2) use a dedicated `GENERACY_CLOUD_ISSUER` to derive the URL, or (3) use an explicit `GENERACY_CLOUD_JWKS_URL` override. The instruction is to "pick whichever matches what generacy-cloud actually exposes — coordinate with generacy-ai/generacy-cloud#413 author."
**Question**: Which configuration pattern should we implement? Specifically: does generacy-cloud serve a JWKS endpoint at `/.well-known/jwks.json`, and should we use `GENERACY_CLOUD_API_URL` as the base or a separate env var?
**Options**:
- A: Primary `GENERACY_CLOUD_API_URL` + `/.well-known/jwks.json`, with `GENERACY_CLOUD_JWKS_URL` as override
- B: Dedicated `GENERACY_CLOUD_JWKS_URL` required (no derivation)
- C: Derive from `GENERACY_CLOUD_ISSUER` (standard OIDC discovery)

**Answer**: None of the offered options — HS256 precludes JWKS. Skip local signature verification in the daemon. Device tokens are signed with HS256 (symmetric), not an asymmetric algorithm. Recommended approach: daemon parses JWT structurally (no signature check) to extract claims, validates claim shape (sub, org_id, scope === "credhelper", exp not in past), rejects obviously-broken tokens with 400, and defers signature validation to the cloud on every `fetchSecret()` call. Remove `jose` full verification from scope; use `jose.decodeJwt()` for parsing only. Only env var needed: `GENERACY_CLOUD_API_URL`.

### Q4: backendKey Format for generacy-cloud
**Context**: The spec states `backendKey` should be "the credential ID as stored in generacy-cloud" and references the UI flow from generacy-ai/generacy-cloud#414 where users pick a human-readable name. It says "that name (or the generated ID) becomes the backendKey" without resolving which one. This determines the URL path segment in `POST /api/organizations/:orgId/credentials/:id/resolve`.
**Question**: Is `backendKey` the user-chosen human-readable name (e.g., `my-stripe-key`) or the Firestore document ID (e.g., `cred_a1b2c3d4`)?
**Options**:
- A: Human-readable name — the resolve endpoint accepts names
- B: Firestore document ID — the resolve endpoint requires the internal ID
- C: Either — the resolve endpoint accepts both (looked up by name or ID)

**Answer**: A — Human-readable name. `backendKey` in `credentials.yaml` is the user-chosen human-readable name (e.g., `my-stripe-key`). However, the cloud resolve endpoint must accept names, not just Firestore doc IDs. Action: verify the cloud resolve endpoint; if it only accepts Firestore IDs, file a sub-issue in generacy-cloud to extend it. If the cloud endpoint can't be changed quickly, fall back to Firestore doc IDs for v1.5.

### Q5: Token File Ownership Model
**Context**: The spec requires the session-token file at `/run/generacy-credhelper/session-token` to be written with "mode 0600, owner credhelper:credhelper". The current daemon codebase has no evidence of a `credhelper` system user — it runs as whatever Node.js process user launches it. Setting file ownership to a different user requires root privileges (`fs.chown()`).
**Question**: Does the daemon process run as a dedicated `credhelper` system user (so mode 0600 with default ownership is sufficient), or should the implementation attempt `chown` to a specific user?
**Options**:
- A: Daemon runs as `credhelper` user — just set mode 0600, ownership follows process uid
- B: Daemon runs as root — must `chown` to `credhelper:credhelper` after write
- C: Ignore ownership, just set mode 0600 with process uid — the "credhelper:credhelper" in the spec is aspirational

**Answer**: A — Daemon runs as `credhelper` user (uid 1002, primary group `node`, added in tetrad-development#59). Files created naturally have owner credhelper:node; mode 0600 gives exclusive access. Use atomic write via temp file + rename. No chown needed. The spec's `credhelper:credhelper` group is slightly off — actual group is `node` — but irrelevant for mode 0600.
