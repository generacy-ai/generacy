# Feature Specification: Credhelper Daemon — Session Lifecycle & Unix Socket API

**Branch**: `461-credentials-architecture` | **Date**: 2026-04-13 | **Status**: Draft

## Summary

Implement the credhelper daemon (Phase 2 of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md)). This is the core runtime — a long-lived Node.js process inside `packages/credhelper/` that runs under uid `credhelper` (1002) in each worker container, managing credential sessions for workflow runs via Unix domain sockets.

**Depends on:** Phase 1 (#458 credhelper skeleton) | **Parallel with:** #460 (plugins), #462 (config loader)

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

### US1: Worker starts a credential session for a workflow run

**As a** worker process,
**I want** to request a credential session from the credhelper via the control socket,
**So that** the workflow run gets a session directory with properly scoped credentials (env files, git helpers, GCP configs) ready to use.

**Acceptance Criteria**:
- [ ] `POST /sessions` with a valid role and session_id returns a session directory path and expiration time
- [ ] Session directory is created at `/run/generacy-credhelper/sessions/<id>/` with mode 0750, owned `credhelper:node`
- [ ] All exposure files (env, git config, gcp external-account.json, data.sock) are rendered correctly
- [ ] Only connections from the worker uid (1000) are accepted (SO_PEERCRED enforcement)

### US2: Workflow retrieves credentials on demand via data socket

**As a** workflow process (uid 1001),
**I want** to fetch fresh credentials from the per-session data socket,
**So that** git credential helpers and gcloud external-account can transparently obtain tokens without credentials being baked into the environment.

**Acceptance Criteria**:
- [ ] `GET /credential/<credential-id>` on `data.sock` returns the current token value
- [ ] Data socket is mode 0660, group-readable by `node` group
- [ ] Background refresher keeps tokens fresh at 75% of TTL
- [ ] Expired or failed credentials return an error, not stale data

### US3: Worker ends a credential session after workflow completes

**As a** worker process,
**I want** to delete a credential session via `DELETE /sessions/<id>`,
**So that** all secrets are wiped from memory and disk, and per-session sockets are closed.

**Acceptance Criteria**:
- [ ] Session directory is fully removed
- [ ] In-memory credential values for the session are cleared
- [ ] Per-session data socket is closed
- [ ] Any per-session proxy state is torn down

### US4: Credhelper fails closed on invalid state

**As a** platform operator,
**I want** the credhelper to exit or reject requests when configuration is invalid, plugins are missing, or the backend is unreachable,
**So that** workflows never silently run with missing or stale credentials.

**Acceptance Criteria**:
- [ ] Backend unreachable at boot → exit non-zero
- [ ] Invalid/missing role or plugin → exit non-zero
- [ ] Unsupported exposure for a credential type → session start fails with clear error
- [ ] Backend unreachable mid-run → cached values served until expiry, then requests fail
- [ ] Plugin mint failure mid-run → credential unavailable, logged, credhelper stays up

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Bind control socket at `/run/generacy-credhelper/control.sock` with mode 0600 | P1 | Owned by worker uid (1000) |
| FR-002 | SO_PEERCRED verification on every control socket connection | P1 | Reject non-worker uid |
| FR-003 | JSON-over-Unix-socket request/response protocol on control socket | P1 | |
| FR-004 | `POST /sessions` endpoint — validate role, mint/resolve credentials, render exposure files | P1 | Depends on #460 plugins, #462 config |
| FR-005 | `DELETE /sessions/<id>` endpoint — wipe session dir, clear memory, close sockets | P1 | |
| FR-006 | Per-session data socket at `sessions/<id>/data.sock` (mode 0660, group `node`) | P1 | |
| FR-007 | HTTP-over-Unix-socket `GET /credential/<id>` on data socket | P1 | |
| FR-008 | Background token refresh at 75% of mint TTL | P1 | `env` exposure does NOT refresh |
| FR-009 | In-memory credential store (`Map<credentialId, {value, expiresAt}>`) — never written to disk | P1 | Security requirement |
| FR-010 | Graceful shutdown on SIGTERM — end all sessions, clean dirs, close sockets | P1 | |
| FR-011 | All failure modes fail closed per specification | P1 | See failure modes section |
| FR-012 | Startup: load config, load plugins, bind control socket, enter ready state | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Control socket SO_PEERCRED enforcement | 100% rejection of non-worker uids | Unit test with mock peer credentials |
| SC-002 | Session lifecycle correctness | Begin + end works end-to-end with mock plugin | Integration test |
| SC-003 | Session directory permissions | 0750, owned credhelper:node | Automated permission check in tests |
| SC-004 | Data socket credential serving | Fresh tokens returned for valid credential IDs | Integration test with real Unix socket |
| SC-005 | Token refresh timing | Fires at 75% of TTL | Unit test with mock timers |
| SC-006 | Session cleanup completeness | No residual files, memory, or sockets after DELETE | Unit test asserting clean state |
| SC-007 | Fail-closed behavior | All 6 failure modes behave as specified | Dedicated test per failure mode |

## Assumptions

- Phase 1 (#458) credhelper skeleton package exists and provides the project structure
- Plugin system (#460) exposes `mint()` and `resolve()` methods with a standard interface
- Config loader (#462) provides role validation and credential-to-plugin mapping
- Worker containers run on Linux with Unix domain socket and SO_PEERCRED support
- Session directories are on tmpfs (not persistent storage)
- UIDs are fixed: node=1000, workflow=1001, credhelper=1002

## Out of Scope

- Docker socket proxy (Phase 3)
- Plugin implementation (covered by #460)
- Config/role file format and loading (covered by #462)
- Container entrypoint script changes
- Backend API for credential minting (consumed, not implemented here)

---

*Generated by speckit*
