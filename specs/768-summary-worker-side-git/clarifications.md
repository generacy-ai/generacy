# Clarifications

Tracks open questions and their resolutions for [#768](https://github.com/generacy-ai/generacy/issues/768).

## Batch 1 — 2026-06-05

### Q1: Listen-socket parent directory creation
**Context**: The default listen socket path is `/run/generacy-git-token/control.sock`. The spec (FR-002, FR-008) specifies the socket file path and mode (`0660`) but is silent on whether the bin must create the parent directory `/run/generacy-git-token/`. Cluster-base typically pre-creates such directories via tmpfs mounts in `entrypoint-orchestrator.sh` (mirroring how `/run/generacy-control-plane/` is set up for the upstream socket). If the bin also tries to `mkdir`, it would need to decide on owner/mode and might race with cluster-base. If it doesn't, a misconfigured cluster-base would cause an opaque `EACCES`/`ENOENT` at bind time.
**Question**: Should the packaged bin create the parent directory of the listen socket, or fail loudly if it doesn't exist?
**Options**:
- A: Bin assumes parent directory exists (created by cluster-base entrypoint). Bind failure → exit non-zero with a structured stderr line that names the missing path. No `mkdir` call. (mirrors how `git-credential-generacy` does no path setup)
- B: Bin runs `mkdirSync(dirname(socketPath), { recursive: true, mode: 0o2770 })` before bind. Owns the directory lifecycle itself.
- C: Bin probes parent existence; if missing, exits non-zero with a clear message but does not create. Same as A but with an explicit precondition check before `listen()`.

**Answer**: **A** — Bin assumes the parent directory exists (cluster-base owns the `/run/generacy-git-token/` tmpfs lifecycle). On bind failure, exit non-zero with a structured stderr line naming the missing path. No `mkdir` call, no probe. Mirrors `git-credential-generacy`'s no-path-setup pattern; avoids racing with the entrypoint.

### Q2: Request header passthrough policy
**Context**: FR-005 specifies the body is forwarded and US2 names `content-type`/`content-length` as forwarded headers. The spec is silent on every other request header (`host`, `accept`, `user-agent`, `authorization`, custom `x-*`). This matters for the security boundary: if workers can forward arbitrary headers, they can probe / influence upstream behavior beyond what the allow-list intends. The existing cluster-base script's exact behavior here is the de-facto contract, but the spec needs to nail it down so the new bin doesn't silently tighten or loosen it.
**Question**: Which request headers should be forwarded from the worker side to the upstream `/git-token` route?
**Options**:
- A: Forward **only** `content-type` and `content-length` (allow-list). Strip everything else, including `host`, `authorization`, `accept`, and any `x-*` headers. Most defensive; tested explicitly.
- B: Forward all worker-supplied headers verbatim. Matches a "transparent proxy" model and minimizes deviation from the existing cluster-base script if it does this today.
- C: Allow-list (`content-type`, `content-length`) **plus** allow a small named set (`accept`, `user-agent`) for diagnostic purposes; strip everything else.

**Answer**: **A** — Forward only `content-type` and `content-length`. Strip everything else, including `host`, `authorization`, `accept`, and any `x-*` headers. The proxy is a privilege boundary (worker → control-plane); workers must not be able to inject headers to influence upstream behavior. Matches the existing cluster-base script, which *constructs* exactly those two headers rather than passing `req.headers` through. Allow-list must be tested explicitly.

### Q3: Proxy process logging
**Context**: The control-plane process emits structured JSON log lines (e.g., `{ event: 'git-token-init', ... }`). The cluster-base script may log plain-text lines to stderr. The spec doesn't say what the packaged bin should emit — startup banner, per-request log lines, error log lines on upstream failure. Logging is observability-relevant (oncall reads container stdout/stderr) but tokens must never appear in logs.
**Question**: What should the packaged bin log, and in what format?
**Options**:
- A: Structured JSON lines on stdout — one on startup (`{ event: 'git-token-proxy-init', listenSocket, upstreamSocket }`), one per upstream failure (`{ event: 'git-token-proxy-upstream-error', code }`). No per-request success log. No body / header content ever logged. Matches the control-plane convention.
- B: Plain-text lines on stderr (e.g., `git-token-proxy: listening on …`, `git-token-proxy: upstream unreachable: <reason>`). Matches typical Node CLI style.
- C: Silent on success, single stderr line on bind failure or upstream error. Lowest noise; oncall can grep for "git-token-proxy".

**Answer**: **A** — Structured JSON lines on stdout: one on startup (`{ event: 'git-token-proxy-init', listenSocket, upstreamSocket }`) and one per upstream failure (`{ event: 'git-token-proxy-upstream-error', code }`). No per-request success log, no body/header content ever logged (tokens must not appear in logs). Matches the `@generacy-ai/control-plane` package's existing structured-log convention.

### Q4: Unit-test style for the bin
**Context**: SC-002 / SC-003 require vitest unit tests in `packages/control-plane` for the allow-list and upstream-unreachable mapping. Two viable styles: (1) instantiate a real Unix-socket HTTP server in a tmp dir and drive it via `http.request({ socketPath })`, with a fake upstream socket (also in tmp dir) that the tests control; or (2) refactor the bin into pure handler functions and test them in isolation with `Mock` Node `http` request/response objects. Style choice affects how the bin is structured (entry-point thin / logic factored out) and how robust tests are to Node version drift.
**Question**: Which unit-test style should the bin be designed for?
**Options**:
- A: Real Unix-socket integration tests inside `vitest` — tmp dir per test, fake upstream socket spun up by the test, real HTTP requests. Tests the wire contract end-to-end. Linux-only (skipped on macOS dev machines if any).
- B: Pure-function tests — factor the bin into `createServer(upstreamSocketPath, logger)` and exported request handler; tests call the handler with mock req/res. Cross-platform, faster, doesn't exercise the actual `net.createServer({path})` code.
- C: Hybrid — pure-function tests for the allow-list and header-forwarding logic, plus one real-socket smoke test for the bind / mode / shutdown lifecycle. Skipped automatically on non-POSIX.

**Answer**: **C** — Hybrid. Factor the security-critical logic (single-route allow-list, header allow-list, `CONTROL_SOCKET_UNREACHABLE` error mapping) into pure functions and unit-test them fast and cross-platform. Add one real Unix-socket lifecycle smoke test that exercises bind, `0660` socket mode, single-route enforcement on the wire, and SIGTERM cleanup (skipped automatically on non-POSIX). Better coverage for a privilege boundary than all-mock or all-integration.

### Q5: Request body size and upstream timeout limits
**Context**: The existing script likely has no body-size limit and no upstream timeout — workers POST `{}` (2 bytes) and the upstream responds in milliseconds. The spec doesn't set explicit defensive limits. Two failure modes worth pinning down: (a) a worker POSTs a multi-MB body (DoS the proxy or the upstream); (b) the upstream hangs (cloud-pull stuck), and the proxy holds the connection indefinitely. Both are unlikely but cheap to bound.
**Question**: Should the bin enforce a max request body size and/or an upstream-response timeout?
**Options**:
- A: No limits in v1 — preserve existing-script behavior exactly. Defer hardening to a follow-up issue if/when observed.
- B: Max body 64 KiB (413 on overflow); upstream-response timeout 30 s (mapped to `502 CONTROL_SOCKET_UNREACHABLE` like other transport failures). Bounds are documented in the bin source.
- C: Max body 8 KiB only (worker POSTs `{}`, no need for headroom). No timeout — control-plane's own request handling owns liveness.

**Answer**: **B** — Max body 64 KiB (respond with HTTP 413 on overflow); upstream-response timeout 30 s (mapped to `502 CONTROL_SOCKET_UNREACHABLE`, matching other transport failures). Bounds documented in the bin source. The upstream timeout is the load-bearing one: if cloud-pull hangs, the proxy must fail fast and clearly rather than holding the connection (and the blocked `git` op) open indefinitely. 64 KiB gives generous headroom over the real `{}`-sized payload while still bounding a malicious worker body.
