# Feature Specification: ## Credentials Architecture — Phase 2 (parallel with #460 and #462)

**Context:** Part of the [credentials architecture plan](https://github

**Branch**: `461-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

## Credentials Architecture — Phase 2 (parallel with #460 and #462)

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md). This is the core runtime of the credhelper.

**Depends on:** Phase 1 (#458 credhelper skeleton)

## What needs to be done

Implement the credhelper daemon inside `packages/credhelper/`. This is a long-lived Node.js process that runs inside each worker container under uid `credhelper` (1002). It manages credential sessions for workflow runs.

### Control socket (worker → credhelper)

1. Bind a Unix domain socket at `/run/generacy-credhelper/control.sock`
2. Socket mode `0600`, owned by the worker uid (node, 1000)
3. **SO_PEERCRED verification** on every connection — reject anything that isn't the worker uid (belt-and-suspenders: filesystem DAC + kernel-verified peer credentials)
4. Protocol: simple JSON-over-Unix-socket request/response
5. Endpoints:
   - `POST /sessions` — `{ role: string, session_id: string }` → `{ session_dir: string, expires_at: string }`
   - `DELETE /sessions/<id>` → `{ ok: true }`

### Session lifecycle

1. **Begin session** (`POST /sessions`):
   - Validate the requested role exists and passes validation (calls the config loader from #462)
   - For each credential in the role, call the plugin's `mint()` or `resolve()` method (plugins loaded by #460)
   - Render exposure files into a session directory under `/run/generacy-credhelper/sessions/<id>/`
   - Session directory layout (mode 0750, owned `credhelper:node`):
     ```
     /run/generacy-credhelper/sessions/<id>/
     ├── env                       # sourceable env file
     ├── git/
     │   ├── config                # credential.helper pointing at helper script
     │   └── credential-helper     # script that talks to data.sock
     ├── gcp/
     │   └── external-account.json # credential_source.url → data.sock
     ├── docker.sock               # scoped docker socket proxy endpoint (Phase 3)
     └── data.sock                 # workflow-group readable, talks back to credhelper
     ```
   - Return the session directory path and expiration time

2. **End session** (`DELETE /sessions/<id>`):
   - Wipe the session directory
   - Clear in-memory credentials for that session
   - Tear down any per-session proxy state
   - Close the data socket for this session

### Data socket (workflow → credhelper)

1. Per-session Unix socket at `/run/generacy-credhelper/sessions/<id>/data.sock`
2. Mode `0660`, group-readable by `node` group (so workflow uid 1001 can connect)
3. Used by git credential helpers and gcloud external account to fetch fresh tokens on demand
4. Simple HTTP-over-Unix-socket: `GET /credential/<credential-id>` → token

### Background token refresher

1. For each credential with a `mint` TTL, schedule refresh at 75% of TTL
2. Helper/proxy/external-account exposures see fresh values transparently via data.sock
3. `env` exposure does NOT refresh — mint TTL must cover the full workflow (documented trade-off)

### Secret lifecycle

- **Memory-only in the credhelper.** Plugin `mint`/`resolve` returns a value; credhelper holds it in a `Map<credentialId, { value, expiresAt }>`. Never written to disk.
- **Rendered exposure forms may hit tmpfs** — the `env` file and gcloud JSON do. For `env`, the secret is on tmpfs and readable by workflow uid. For gcloud, the JSON contains a URL pointing at data.sock (not the token itself).

### Failure modes (all fail closed)

- Backend unreachable at boot → exit non-zero
- Role file missing or invalid → exit non-zero
- Plugin missing, unpinned, or schema-invalid → exit non-zero
- Role tries unsupported exposure for a credential type → session start fails with clear error
- Backend unreachable mid-run → serve cached values until expiry, then fail requests
- Plugin mint throws mid-run → that credential becomes unavailable, logged, credhelper stays up

### Startup / shutdown

- Credhelper is started by the worker container's entrypoint script as a background process under uid 1002
- On startup: load config (#462), load plugins (#460), bind control socket, enter ready state
- On SIGTERM: end all active sessions, clean up session dirs, close sockets, exit

## Acceptance criteria

- Control socket binds correctly with SO_PEERCRED enforcement
- Session begin/end lifecycle works end-to-end with a mock plugin
- Session directory is created with correct ownership and permissions
- Data socket serves fresh credentials to connecting clients
- Background refresher fires at 75% TTL
- All failure modes fail closed as specified
- Unit tests covering: session lifecycle, SO_PEERCRED rejection, token refresh, cleanup on session end
- Integration test with a real Unix socket

## Phase grouping

- **Phase 2** — parallel with #460 and #462

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
