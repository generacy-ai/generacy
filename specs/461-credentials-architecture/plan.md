# Implementation Plan: Credhelper Daemon with Session Lifecycle and Unix Socket API

**Feature**: Implement the credhelper daemon runtime in a new `packages/credhelper-daemon` package — HTTP-over-Unix-socket control and data APIs, session lifecycle, exposure file rendering, background token refresh, and fail-closed error handling.
**Branch**: `461-credentials-architecture`
**Status**: Complete

## Summary

Phase 2 of the credentials architecture builds the credhelper daemon — a long-lived Node.js process that manages credential sessions for workflow runs inside worker containers. It binds two kinds of Unix sockets:

1. **Control socket** (`/run/generacy-credhelper/control.sock`) — the worker process uses this to begin/end sessions via HTTP `POST /sessions` and `DELETE /sessions/:id`.
2. **Data sockets** (per-session at `/run/generacy-credhelper/sessions/<id>/data.sock`) — workflow processes use these to fetch fresh credentials on demand via HTTP `GET /credential/:credentialId`.

The daemon resolves credentials through plugins (#460), validates roles through config (#462), renders exposure files (env, git-credential-helper, gcloud-external-account), and keeps mint-based credentials fresh via background refresh at 75% TTL.

This phase explicitly defers `localhost-proxy` and `docker-socket-proxy` exposure types to Phase 3 — requesting those returns a clear "not yet implemented" error.

## Technical Context

- **Language**: TypeScript (ES2022, NodeNext module resolution)
- **Runtime**: Node.js ≥ 20
- **Package manager**: pnpm 9 with workspace protocol
- **Test framework**: Vitest
- **HTTP**: Node.js built-in `http` module (not Express) — bound to Unix socket paths
- **Dependencies from Phase 1**: `@generacy-ai/credhelper` (types + Zod schemas)
- **Parallel phases**: #460 (plugin loader), #462 (config loader) — interfaces exist but runtime implementations may not be ready; use adapter interfaces with mock implementations for testing

## Project Structure

```
packages/credhelper-daemon/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                        # Main entry: daemon bootstrap
│   ├── daemon.ts                       # Daemon class: startup, shutdown, socket binding
│   ├── control-server.ts               # HTTP server on control socket (POST/DELETE /sessions)
│   ├── data-server.ts                  # HTTP server factory for per-session data sockets
│   ├── session-manager.ts              # Session lifecycle: begin, end, sweep expired
│   ├── credential-store.ts             # In-memory credential cache (Map<id, {value, expiresAt}>)
│   ├── token-refresher.ts             # Background refresh scheduler (75% TTL)
│   ├── exposure-renderer.ts            # Renders session directory files (env, git, gcp)
│   ├── peer-cred.ts                    # SO_PEERCRED verification for Unix sockets
│   ├── errors.ts                       # CredhelperError class, error codes, response helper
│   ├── types.ts                        # Internal daemon types (DaemonConfig, SessionState, etc.)
│   └── util/
│       ├── parse-ttl.ts                # Parse TTL strings ("1h", "30m") to milliseconds
│       └── fs.ts                       # Filesystem helpers (mkdir, chmod, chown, rm -rf)
├── bin/
│   └── credhelper-daemon.ts            # CLI entry point (parse args, instantiate Daemon, run)
└── __tests__/
    ├── control-server.test.ts          # Control socket endpoint tests
    ├── data-server.test.ts             # Data socket credential serving tests
    ├── session-manager.test.ts         # Session lifecycle tests
    ├── credential-store.test.ts        # In-memory store tests
    ├── token-refresher.test.ts         # Refresh scheduling tests
    ├── exposure-renderer.test.ts       # File rendering tests (env, git, gcp)
    ├── peer-cred.test.ts              # SO_PEERCRED verification tests
    ├── errors.test.ts                  # Error formatting tests
    ├── integration/
    │   └── session-lifecycle.test.ts   # End-to-end: begin → serve → refresh → end
    └── mocks/
        ├── mock-plugin.ts              # CredentialTypePlugin stub
        └── mock-config-loader.ts       # Config loader stub returning fixture data
```

## Architecture Overview

```
                         Worker (uid 1000)
                              │
                    POST /sessions {role, session_id}
                              │
                    ┌─────────▼─────────┐
                    │  Control Socket    │  /run/generacy-credhelper/control.sock
                    │  (HTTP server)     │  mode 0600, owned uid 1000
                    │  SO_PEERCRED gate  │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Session Manager   │
                    │  - validate role   │◄─── Config Loader (#462 interface)
                    │  - mint/resolve    │◄─── Plugin Loader (#460 interface)
                    │  - render files    │
                    │  - bind data sock  │
                    └─────────┬─────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        ┌─────▼─────┐  ┌─────▼─────┐  ┌──────▼──────┐
        │ env file   │  │ git/      │  │ gcp/        │
        │ KEY=val    │  │ config    │  │ external-   │
        │            │  │ cred-help │  │ account.json│
        └────────────┘  └───────────┘  └─────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Data Socket       │  /run/.../sessions/<id>/data.sock
                    │  (HTTP server)     │  mode 0660, group node
                    │  GET /credential/x │
                    └─────────┬─────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Credential Store  │  Map<credId, {value, expiresAt}>
                    │  + Token Refresher │  refresh at 75% TTL
                    └───────────────────┘
```

## Implementation Phases

### Phase A: Package scaffold and core infrastructure

1. **Create `packages/credhelper-daemon/`** — package.json, tsconfig.json, vitest.config.ts
2. **`src/types.ts`** — internal types: `DaemonConfig`, `SessionState`, `CredentialCacheEntry`, `ErrorCode`
3. **`src/errors.ts`** — `CredhelperError` class with `code`, `details`, `toResponse()` method; error code enum
4. **`src/peer-cred.ts`** — SO_PEERCRED extraction via `getsockopt(SOL_SOCKET, SO_PEERCRED)` using the socket fd; falls back to `socket.remoteAddress` check; verification function that rejects non-worker UIDs
5. **`src/util/parse-ttl.ts`** — parse duration strings to milliseconds
6. **`src/util/fs.ts`** — async wrappers for mkdir, chmod, chown, rm

### Phase B: Credential store and token refresh

7. **`src/credential-store.ts`** — `CredentialStore` class: `set(sessionId, credId, value, expiresAt)`, `get(sessionId, credId)`, `clearSession(sessionId)`, `isExpired(sessionId, credId)`
8. **`src/token-refresher.ts`** — `TokenRefresher` class: schedules refresh at 75% TTL using `setTimeout`; calls plugin `mint()` and updates the store; handles mint failures (mark credential unavailable, log, don't crash)

### Phase C: Exposure rendering

9. **`src/exposure-renderer.ts`** — `ExposureRenderer` class with methods:
   - `renderEnv(entries)` → writes sourceable env file
   - `renderGitCredentialHelper(dataSocketPath)` → writes git config + credential-helper script
   - `renderGcloudExternalAccount(dataSocketPath, credentialId)` → writes external-account JSON
   - Phase 3 stubs: `localhost-proxy` and `docker-socket-proxy` throw "not yet implemented"
   - All file operations set correct modes and ownership

### Phase D: Session manager

10. **`src/session-manager.ts`** — `SessionManager` class:
    - `beginSession(request)` → validates role via config loader, resolves/mints credentials via plugins, creates session directory, renders exposure files, starts data socket, returns session info
    - `endSession(sessionId)` → wipes session dir, clears credential store, closes data socket
    - Expiry sweeper: `setInterval` every 30s checks for expired sessions, auto-cleans, logs warning
    - Tracks all active sessions in a `Map<sessionId, SessionState>`

### Phase E: HTTP servers

11. **`src/control-server.ts`** — `ControlServer` class:
    - Creates `http.Server` bound to control socket path
    - `POST /sessions` → parse JSON body, call `sessionManager.beginSession()`, return `{ session_dir, expires_at }`
    - `DELETE /sessions/:id` → call `sessionManager.endSession()`, return `{ ok: true }`
    - SO_PEERCRED check on each connection via the `connection` event
    - Error responses use `CredhelperErrorResponse` format with appropriate HTTP status codes

12. **`src/data-server.ts`** — `createDataServer(sessionId, store, socketPath)` factory:
    - Creates `http.Server` bound to per-session socket path
    - `GET /credential/:credentialId` → look up in credential store, return token value
    - Returns 404 for unknown credentials, 410 for expired credentials

### Phase F: Daemon orchestration

13. **`src/daemon.ts`** — `Daemon` class:
    - Constructor takes `DaemonConfig` (socket paths, UIDs, config/plugin loader interfaces)
    - `start()`: load config, load plugins, validate, bind control socket, start sweeper, enter ready state
    - `stop()`: end all sessions, clean up dirs, close sockets, cancel timers, exit
    - SIGTERM handler calls `stop()`
    - Fail-closed startup: any initialization error → exit non-zero

14. **`src/index.ts`** — exports `Daemon` and `DaemonConfig`
15. **`bin/credhelper-daemon.ts`** — CLI entry: parse env/args for config paths, instantiate Daemon, call `start()`

### Phase G: Tests

16. **Unit tests** — credential store, token refresher, exposure renderer, peer-cred, errors, parse-ttl
17. **Control server tests** — mock session manager, test routing, error responses, request validation
18. **Data server tests** — mock credential store, test credential serving
19. **Session manager tests** — mock plugin/config, test full begin/end lifecycle, expiry sweeper
20. **Integration test** — real Unix sockets: start daemon, POST session, GET credential via data socket, DELETE session, verify cleanup

## Key Design Decisions

### D1: Node built-in `http` module, not Express
The daemon uses Node's `http.createServer()` bound to Unix socket paths. Express would be overkill — there are only 2-3 routes per server, and Unix sockets don't need middleware, CORS, or other HTTP niceties. The `http` module gives routing via URL parsing, status codes, and content-length framing with zero dependencies.

### D2: Adapter interfaces for #460/#462 dependencies
The session manager depends on config loading (#462) and plugin loading (#460), which may not be implemented yet. Define narrow adapter interfaces (`ConfigLoader`, `PluginRegistry`) in `src/types.ts` that mirror the expected contracts. Tests use mock implementations; the real integrations plug in when #460/#462 ship.

### D3: SO_PEERCRED via raw socket fd
Node.js doesn't expose `SO_PEERCRED` natively. Use `socket._handle.fd` to get the file descriptor, then call `getsockopt` via a small native addon or use the `unix-dgram` / `node-unix-credentials` npm package. If neither is acceptable, fall back to filesystem-only DAC protection with a log warning that kernel-level peer verification is disabled. The spec calls for belt-and-suspenders (DAC + SO_PEERCRED), so the filesystem permissions are the primary gate.

### D4: In-memory credential store, never on disk
Credentials are held in a `Map` in the daemon process. The only on-disk artifacts are exposure files (env, git config, gcloud JSON) on tmpfs. The `env` file contains the actual secret value (documented trade-off). The gcloud JSON contains a URL pointing at the data socket, not the token itself. Git credential helper is a script that queries the data socket.

### D5: Sweeper interval for expired sessions
A `setInterval` running every 30 seconds checks all sessions for expiry. This is simple and sufficient — session durations are on the order of minutes to hours, so 30s granularity is fine. The sweeper logs a warning for each auto-cleaned session (indicates the worker didn't call DELETE).

### D6: Graceful shutdown on SIGTERM
The daemon registers a SIGTERM handler that: (1) stops accepting new connections on the control socket, (2) ends all active sessions (wipe dirs, clear store, close data sockets), (3) closes the control socket, (4) exits cleanly. This ensures no credential material survives the daemon process.

## Dependencies

### Runtime
- `@generacy-ai/credhelper` (workspace dependency — types + schemas)
- No other runtime dependencies (Node built-ins only: `http`, `net`, `fs`, `path`, `os`, `child_process`)

### Dev
- `@types/node ^20.14.0`
- `typescript ^5.4.5`
- `vitest ^4.0.18`

### Optional (for SO_PEERCRED)
- Native addon TBD — evaluate `node-unix-credentials` or implement minimal N-API binding. If the overhead is unacceptable, SO_PEERCRED can be implemented via `process.binding('pipe_wrap')` or deferred with a DAC-only fallback.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| SO_PEERCRED not available in Node.js without native addon | Reduced security (DAC-only) | Filesystem permissions are the primary gate; SO_PEERCRED is belt-and-suspenders. Can ship with DAC-only and add native binding later |
| #460/#462 not ready when daemon ships | Can't do real integration testing | Adapter interfaces + mock implementations; integration tests with real plugins run when phases merge |
| Session directory cleanup race conditions | Leaked files on tmpfs | Sweeper + SIGTERM handler both clean up; session dirs are on tmpfs so worst case they're lost on container restart |
| Token refresh timing drift under load | Slightly stale credentials | 75% TTL gives 25% buffer; credentials remain valid until actual expiry regardless of refresh timing |

## Constitution Check

No `constitution.md` found in the project. No governance constraints to verify against.
