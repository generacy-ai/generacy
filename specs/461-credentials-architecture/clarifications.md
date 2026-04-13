# Clarifications for #461: Credhelper Daemon

## Batch 1 — 2026-04-13

### Q1: Control Socket Protocol Framing
**Context**: The data socket is explicitly specified as "HTTP-over-Unix-socket" (line 56 of spec), but the control socket says "JSON-over-Unix-socket" (line 20). This distinction affects the entire server implementation — HTTP gives routing via URL paths, status codes, and content-length framing for free, while raw JSON needs a custom framing protocol (newline-delimited, length-prefixed, etc.).
**Question**: Should the control socket also use HTTP-over-Unix-socket (Node's `http.createServer` bound to a Unix socket path), or a simpler protocol like newline-delimited JSON streams?
**Options**:
- A: HTTP-over-Unix-socket for both control and data sockets (consistent, leverages Node's http module for routing and framing)
- B: Newline-delimited JSON for control socket, HTTP for data socket (lighter-weight control channel)

**Answer**: A — HTTP-over-Unix-socket for both control and data sockets.**

Use Node's `http.createServer()` bound to the Unix socket path for both. HTTP gives us routing (`POST /sessions`, `DELETE /sessions/:id`), status codes (400/404/502/etc.), content-length framing, and the ability to use standard HTTP clients in the worker (`http.request` with `socketPath`). A custom newline-delimited JSON protocol would need its own framing, routing, and error handling for zero benefit — HTTP does all of this out of the box over a Unix socket.

Consistency between control and data sockets also means one server implementation pattern, not two.

---

### Q2: Session Expiration Behavior
**Context**: `POST /sessions` returns an `expires_at` timestamp, but the spec doesn't describe what happens when that time is reached without an explicit `DELETE /sessions/<id>`. This determines whether the daemon needs a background sweeper/timer to auto-cleanup expired sessions or just passively refuses to serve stale credentials.
**Question**: When `expires_at` is reached and the worker hasn't called DELETE, should the daemon automatically clean up the session (wipe directory, clear memory, close data socket), or should it only stop serving credentials and wait for an explicit DELETE?
**Options**:
- A: Auto-cleanup on expiry (daemon runs a sweeper that tears down expired sessions)
- B: Stop serving credentials but wait for explicit DELETE to clean up resources
- C: Auto-cleanup on expiry AND log a warning (indicates the worker didn't clean up properly)

**Answer**: C — auto-cleanup on expiry AND log a warning.**

The normal flow is: worker calls `DELETE /sessions/<id>` when the agent subprocess exits. If `expires_at` is reached without DELETE, something went wrong — the worker crashed, hung, or leaked a session. The daemon should:

1. Auto-cleanup (wipe session dir, clear in-memory credentials, close data socket, tear down proxy state) — prevents resource leaks
2. Log a warning naming the session ID and how long it was overdue — makes the problem visible for debugging

The daemon must never wait indefinitely for a DELETE that may never come. A simple `setInterval` sweeper (check every 30s) is sufficient.

---

### Q3: localhost-proxy Exposure Scope
**Context**: The type system defines a `localhost-proxy` exposure kind and the roles schema supports proxy configuration (upstream URL, allow/deny rules — e.g., the devops.yaml fixture scopes SendGrid API access). However, the spec's session directory layout only shows env, git, gcp, docker.sock, and data.sock — no proxy artifact. Implementing an HTTP proxy server per session is significant work.
**Question**: Should the daemon start per-session HTTP proxy servers for `localhost-proxy` exposures in this phase (#461), or is proxy support deferred to a later phase?
**Options**:
- A: Implement localhost-proxy in this phase (daemon spins up per-session HTTP proxy on a localhost port)
- B: Defer to a later phase — only implement env, git-credential-helper, and gcloud-external-account exposures for now
- C: Stub the proxy interface (create the socket/port binding but don't implement allow/deny rules yet)

**Answer**: B — defer localhost-proxy to Phase 3.**

Phase 2 should focus on the core session lifecycle with the three simpler exposure types: `env` (file rendering), `git-credential-helper` (script + data socket), and `gcloud-external-account` (JSON + data socket). These cover the most common credential workflows.

The localhost-proxy (HTTP proxy that injects auth headers with method+path allowlists for dumb APIs like SendGrid) is conceptually the same kind of work as the scoped docker socket proxy (#464). Both are Phase 3 work. The daemon should define the proxy hooks in its session lifecycle (port allocation, cleanup) so Phase 3 can plug in, but the actual proxy implementation doesn't belong here.

Concretely: the session lifecycle should handle `localhost-proxy` and `docker-socket-proxy` exposure kinds by throwing a "not yet implemented" error if a role requests them. Phase 3 fills in the implementation.

---

### Q4: Daemon Code Location
**Context**: `packages/credhelper/` currently contains only shared types and Zod schemas with `zod` as its sole dependency. The spec says "implement inside `packages/credhelper/`", but adding the daemon here turns it into a runtime package with Node.js built-in dependencies (net, fs, http, child_process). Other consumers (like the worker) that only need the types would pull in unnecessary runtime code.
**Question**: Should the daemon code be added within `packages/credhelper/` (e.g., in `src/daemon/` with a separate bin entry point and dual exports), or should a new package (e.g., `packages/credhelper-daemon`) be created that depends on `packages/credhelper` for types?
**Options**:
- A: Same package with a `src/daemon/` subdirectory and a separate bin entry point (simpler setup, single package)
- B: New `packages/credhelper-daemon` package that imports types from `packages/credhelper` (clean separation, types stay lightweight)

**Answer**: B — new `packages/credhelper-daemon` package.**

Clean separation. `packages/credhelper` stays lightweight (Zod-only) and can be imported by:
- The worker/orchestrator (needs `LaunchRequest` credential types, session API types)
- The AgentLauncher interceptor (#465) (needs control socket client types)
- Test code (needs schemas for fixture validation)

None of those consumers should pull in `net`, `fs`, `http`, `child_process`, or the daemon's runtime dependencies. A separate `packages/credhelper-daemon` imports types from `packages/credhelper` and owns all the runtime code.

This matches the monorepo pattern already established in generacy — separate packages for shared types vs. runtime implementations.

---

### Q5: Error Response Format
**Context**: The spec defines success response shapes (`{ session_dir, expires_at }`, `{ ok: true }`, raw token) but doesn't specify error response format. The worker needs to programmatically distinguish error types (e.g., invalid role vs. plugin failure vs. unsupported exposure) to provide meaningful feedback to users.
**Question**: What format should error responses use on both the control and data sockets? Should they include a machine-readable error code in addition to a human-readable message?
**Options**:
- A: `{ error: string, code: string }` with HTTP status codes (e.g., 400 for invalid role, 502 for backend failure, 404 for unknown session)
- B: `{ error: string }` with HTTP status codes only (simpler, status code carries the category)
- C: `{ error: string, code: string, details?: object }` with HTTP status codes (richest, allows structured context like which plugin failed)

**Answer**: C — `{ error, code, details? }` + HTTP status codes.**

```typescript
interface CredhelperErrorResponse {
  error: string;          // human-readable message
  code: string;           // machine-readable: 'INVALID_ROLE', 'BACKEND_UNREACHABLE', 'PLUGIN_MINT_FAILED', 'SESSION_NOT_FOUND', etc.
  details?: {
    pluginType?: string;  // which plugin failed
    credentialId?: string; // which credential
    backendId?: string;    // which backend
    [key: string]: unknown;
  };
}
```

HTTP status codes for coarse routing:
- 400: client error (invalid role, unsupported exposure, bad request)
- 404: session not found
- 502: backend/plugin failure (upstream error)
- 500: internal credhelper error

The `code` field gives the worker machine-readable classification without string-parsing `error`. The optional `details` helps debugging in logs ("plugin `github-app` failed to mint for credential `github-main-org` — backend returned 401").
