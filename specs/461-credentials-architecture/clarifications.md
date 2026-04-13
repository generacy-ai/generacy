# Clarifications for #461: Credhelper Daemon

## Batch 1 — 2026-04-13

### Q1: Control Socket Protocol Framing
**Context**: The data socket is explicitly specified as "HTTP-over-Unix-socket" (line 56 of spec), but the control socket says "JSON-over-Unix-socket" (line 20). This distinction affects the entire server implementation — HTTP gives routing via URL paths, status codes, and content-length framing for free, while raw JSON needs a custom framing protocol (newline-delimited, length-prefixed, etc.).
**Question**: Should the control socket also use HTTP-over-Unix-socket (Node's `http.createServer` bound to a Unix socket path), or a simpler protocol like newline-delimited JSON streams?
**Options**:
- A: HTTP-over-Unix-socket for both control and data sockets (consistent, leverages Node's http module for routing and framing)
- B: Newline-delimited JSON for control socket, HTTP for data socket (lighter-weight control channel)

**Answer**: *Pending*

### Q2: Session Expiration Behavior
**Context**: `POST /sessions` returns an `expires_at` timestamp, but the spec doesn't describe what happens when that time is reached without an explicit `DELETE /sessions/<id>`. This determines whether the daemon needs a background sweeper/timer to auto-cleanup expired sessions or just passively refuses to serve stale credentials.
**Question**: When `expires_at` is reached and the worker hasn't called DELETE, should the daemon automatically clean up the session (wipe directory, clear memory, close data socket), or should it only stop serving credentials and wait for an explicit DELETE?
**Options**:
- A: Auto-cleanup on expiry (daemon runs a sweeper that tears down expired sessions)
- B: Stop serving credentials but wait for explicit DELETE to clean up resources
- C: Auto-cleanup on expiry AND log a warning (indicates the worker didn't clean up properly)

**Answer**: *Pending*

### Q3: localhost-proxy Exposure Scope
**Context**: The type system defines a `localhost-proxy` exposure kind and the roles schema supports proxy configuration (upstream URL, allow/deny rules — e.g., the devops.yaml fixture scopes SendGrid API access). However, the spec's session directory layout only shows env, git, gcp, docker.sock, and data.sock — no proxy artifact. Implementing an HTTP proxy server per session is significant work.
**Question**: Should the daemon start per-session HTTP proxy servers for `localhost-proxy` exposures in this phase (#461), or is proxy support deferred to a later phase?
**Options**:
- A: Implement localhost-proxy in this phase (daemon spins up per-session HTTP proxy on a localhost port)
- B: Defer to a later phase — only implement env, git-credential-helper, and gcloud-external-account exposures for now
- C: Stub the proxy interface (create the socket/port binding but don't implement allow/deny rules yet)

**Answer**: *Pending*

### Q4: Daemon Code Location
**Context**: `packages/credhelper/` currently contains only shared types and Zod schemas with `zod` as its sole dependency. The spec says "implement inside `packages/credhelper/`", but adding the daemon here turns it into a runtime package with Node.js built-in dependencies (net, fs, http, child_process). Other consumers (like the worker) that only need the types would pull in unnecessary runtime code.
**Question**: Should the daemon code be added within `packages/credhelper/` (e.g., in `src/daemon/` with a separate bin entry point and dual exports), or should a new package (e.g., `packages/credhelper-daemon`) be created that depends on `packages/credhelper` for types?
**Options**:
- A: Same package with a `src/daemon/` subdirectory and a separate bin entry point (simpler setup, single package)
- B: New `packages/credhelper-daemon` package that imports types from `packages/credhelper` (clean separation, types stay lightweight)

**Answer**: *Pending*

### Q5: Error Response Format
**Context**: The spec defines success response shapes (`{ session_dir, expires_at }`, `{ ok: true }`, raw token) but doesn't specify error response format. The worker needs to programmatically distinguish error types (e.g., invalid role vs. plugin failure vs. unsupported exposure) to provide meaningful feedback to users.
**Question**: What format should error responses use on both the control and data sockets? Should they include a machine-readable error code in addition to a human-readable message?
**Options**:
- A: `{ error: string, code: string }` with HTTP status codes (e.g., 400 for invalid role, 502 for backend failure, 404 for unknown session)
- B: `{ error: string }` with HTTP status codes only (simpler, status code carries the category)
- C: `{ error: string, code: string, details?: object }` with HTTP status codes (richest, allows structured context like which plugin failed)

**Answer**: *Pending*
