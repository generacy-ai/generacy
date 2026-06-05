# Research: Worker-side git-token proxy bin

## R-1: Hosting package — control-plane vs cluster-base vs new package

**Decision**: Host the bin in `packages/control-plane` alongside the existing `git-credential-generacy` bin. Ship it from `dist/bin/git-token-proxy.js`.

**Rationale**:
- The proxy's whole job is to forward `POST /git-token` to the route owned by this package (`packages/control-plane/src/routes/git-token.ts`, added in #766). Version-locking the proxy to the route means schema drift can be caught by a single package's tests, not by integration-only.
- This package already produces a per-invocation CLI bin (`git-credential-generacy`) over the same socket abstraction. The build, packaging, install path, and `dist/bin/*.js` convention are already in place.
- Cluster-base, where the script lives today, has no TypeScript build, no vitest, no unit-test infrastructure for Node code. Moving the proxy keeps the script but trades type-checking and tests for nothing.
- A standalone `packages/git-token-proxy` would duplicate publishing, CI, and tsconfig for ~200 LOC of glue.

**Alternatives considered**:
- Leave it in cluster-base: rejected — the spec's whole motivation. No type-checking, no tests, drift risk vs. the route shape.
- Move it into credhelper-daemon: rejected — wrong process boundary. credhelper-daemon runs uid 1002 and is the local-secret server; it does not own the worker→orchestrator privilege boundary the proxy enforces, nor the control socket the proxy forwards to.
- New `packages/git-token-proxy`: rejected — infra duplication, same reasoning as #766 R-1.

**Source**: Spec §Scope, §Why.

## R-2: HTTP-over-Unix-socket server in Node

**Decision**: Use `node:http` `createServer((req, res) => …)` bound to a Unix socket via `server.listen({ path: socketPath })`. Forward each accepted request through `http.request({ socketPath: upstream, … })` to the control-plane socket.

**Rationale**:
- This is the same pattern used everywhere else in the cluster: control-plane, credhelper-daemon, and `git-credential-generacy` all serve plain HTTP over a Unix socket using `node:http`. Consistent with cluster conventions.
- `node:http.createServer` already enforces the HTTP framing the proxy needs (request line parsing, header parsing, chunked-encoding, content-length validation). We don't reimplement it.
- No new dependency. The bin's runtime is Node built-ins only — `node:http`, `node:net`, `node:fs/promises`, `node:path`. Keeps the cluster image small and the surface area auditable.

**Pattern (sketch)**:
```ts
const upstreamSocketPath = process.env.CONTROL_PLANE_SOCKET_PATH ?? '/run/generacy-control-plane/control.sock';
const listenSocketPath = process.env.GIT_TOKEN_PROXY_SOCKET ?? '/run/generacy-git-token/control.sock';

const server = http.createServer((req, res) => handle(req, res, { upstreamSocketPath }));
await unlinkIfExists(listenSocketPath);                 // stale socket cleanup
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen({ path: listenSocketPath }, resolve);
});
await fs.chmod(listenSocketPath, 0o660);                // 0660 perms after bind
logProxyInit({ listenSocket: listenSocketPath, upstreamSocket: upstreamSocketPath });
```

**Alternatives considered**:
- Raw `net.createServer` + manual HTTP parsing: rejected. We don't need anything HTTP doesn't already do, and rolling our own parser is exactly the kind of glue this rewrite is trying to eliminate.
- A web framework (fastify, express): rejected. The bin is single-route; a framework would be 5x its size and add startup latency for zero benefit.

**Source**: Spec §Scope (preserve behavior of existing script).

## R-3: Single-route allow-list as a pure function

**Decision**: Express the allow-list as a pure function `isAllowedRoute(method: string, path: string): boolean` that returns `true` **only** for `method === 'POST'` and the path (with query stripped) equalling `/git-token`. Tested exhaustively in `__tests__/bin/git-token-proxy/allowlists.test.ts`.

**Rationale**:
- The allow-list is the security boundary. Spec §Why is explicit: "404s everything else, so workers (and the uid-1001 agent-workflow processes sharing the `node` group) can't reach the orchestrator's full control socket (credential writes, lifecycle actions). That allow-list is a security boundary that deserves tests." Pure-function form is exactly what makes "deserves tests" cheap and exhaustive.
- Pure functions are trivially testable and trivially refactorable. The handler imports `isAllowedRoute(method, path)` and tests can call it directly with `['GET', '/git-token']`, `['POST', '/credentials/foo']`, `['POST', '/git-token?x=y']` (allowed — query stripped), `['POST', '/git-token/']` (rejected — trailing slash significant), etc.
- A literal positive list is clearer than a regex or a route table for one route. Future maintainers shouldn't have to reason about regex anchors or precedence.

**Path-parsing rule**: parse the request URL with `new URL(req.url ?? '', 'http://_')`, take `url.pathname`, exact-string compare. Query is dropped. Trailing slash is significant (`/git-token/` is not allowed).

**Alternatives considered**:
- Inline `if (req.method !== 'POST' || req.url !== '/git-token') 404;`: rejected — gets tangled with header allow-list and body-cap logic. Splitting it out makes the security primitive its own testable unit.
- Configuration-driven allow-list (read routes from a file): rejected — over-engineering. The proxy has one job; encoding the allowed route inline is the right level of indirection.
- Whitelist regex: rejected — harder to read, easier to get wrong (anchors).

**Source**: Spec §Why, §Scope, clarification Q4.

## R-4: Request-header allow-list (content-type + content-length only)

**Decision**: Pure function `pickAllowedHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders` returns a new object containing **only** `content-type` and `content-length` (when present, lowercased). Everything else — `host`, `authorization`, `accept`, every `x-*`, cookies, range, conditional — is stripped.

**Rationale**:
- Per clarification Q2: "The proxy is a privilege boundary (worker → control-plane); workers must not be able to inject headers to influence upstream behavior. Matches the existing cluster-base script, which *constructs* exactly those two headers rather than passing `req.headers` through. Allow-list must be tested explicitly."
- Pure-function form means the test file becomes a literal restatement of the policy: "given these input headers, the output is exactly these two keys."
- The handler does **not** pass `req.headers` through to `http.request` — it always re-constructs the outgoing headers from the allow-list. This means a future addition to Node's default headers, or a hostile worker setting a non-standard header, can't leak in.

**Implementation note**: `content-length` is computed by the proxy when it has buffered the body for the size cap (R-6), not copied verbatim from the inbound request — that ensures a hostile worker can't lie about the length. `content-type` is copied verbatim from the inbound request because we don't parse the body (it's opaque JSON to the proxy).

**Alternatives considered**:
- Transparent passthrough of all worker headers (option B in Q2): rejected. Loosens the privilege boundary for no upside.
- Allow-list plus diagnostics (option C in Q2): rejected. The proxy logs structured JSON itself (R-7); `accept`/`user-agent` add nothing operationally that the logs don't already cover, and they expand the attack surface.

**Source**: Clarification Q2.

## R-5: Upstream-error mapping to `CONTROL_SOCKET_UNREACHABLE`

**Decision**: Pure function `mapUpstreamErrorToCode(err: unknown): 'CONTROL_SOCKET_UNREACHABLE'`. Today's mapping is the identity for every transport failure: `ECONNREFUSED`, `ENOENT`, `EPIPE`, `ECONNRESET`, request timeout, response timeout, socket closed mid-response — every one maps to the same code. Captures the spec's promise: "maps upstream-socket failures to a typed `CONTROL_SOCKET_UNREACHABLE` so the helper never silently falls back to a stale token."

**Rationale**:
- The proxy's contract with the CLI wrapper (#766's `git-credential-generacy`) is that *any* transport-level failure is one named, machine-readable code. The CLI then exits non-zero with the matching `EXIT_CODE_BY_CODE` entry. Operators grep one string.
- A pure function means we can exhaustively test the mapping by simulating each `NodeJS.ErrnoException` shape without spinning up a real socket. The test file becomes the policy document.
- This deliberately collapses multiple upstream failure modes into one code. From the CLI wrapper's standpoint, "control-plane is unreachable" and "control-plane closed the connection mid-response" are operationally identical — both mean "re-fetch and retry, this token is not coming." Distinguishing them at the CLI level would add error codes without adding remediation paths.

**Response shape on upstream failure**: HTTP 502, body `{ "error": "control-plane upstream unreachable", "code": "CONTROL_SOCKET_UNREACHABLE" }` (no `details` — the inner errno is logged but not exposed over the wire; workers don't need it and shouldn't see it).

**Alternatives considered**:
- Distinct codes per errno (ECONNREFUSED vs. ENOENT vs. ETIMEDOUT): rejected. No remediation differs. The structured stdout log already records the `code` field on each failure — operators can correlate.
- Surface the upstream-returned status code on >= 500: rejected. The control-plane route itself is the source of truth for cloud-pull errors (#766's `CLOUD_*` codes); those flow through 5xx response bodies, not through transport failures. Transport vs. application-layer error is the correct cleavage.

**Source**: Spec §Scope, clarification Q5.

## R-6: Body size limit (64 KiB) and upstream-response timeout (30 s)

**Decision**: Buffer the request body up to 64 KiB. On overflow, respond `413 Payload Too Large` with body `{ "error": "request body exceeds 64 KiB", "code": "PAYLOAD_TOO_LARGE" }` and do not contact upstream. After buffering, write the body to the upstream request with a 30 s response timeout (`request.setTimeout(30_000, …)` mapped to abort + `CONTROL_SOCKET_UNREACHABLE` 502).

**Rationale**:
- Per clarification Q5: "The upstream timeout is the load-bearing one: if cloud-pull hangs, the proxy must fail fast and clearly rather than holding the connection (and the blocked `git` op) open indefinitely. 64 KiB gives generous headroom over the real `{}`-sized payload while still bounding a malicious worker body."
- 30 s upstream timeout is generous against the real-world cloud-pull RTT (~hundreds of ms typically) and aligns with how long a human waits before retrying a hung `git fetch`.
- Mapping the timeout to `CONTROL_SOCKET_UNREACHABLE` (rather than introducing a new `UPSTREAM_TIMEOUT` code) preserves the CLI wrapper's "one code, one remediation" contract (R-5).

**Implementation**:
- Read body via `req.on('data', chunk => …)`; abort and 413 immediately when accumulated length exceeds `64 * 1024`. Do not buffer past the limit (no memory blowup).
- For upstream: `const upstreamReq = http.request(opts); upstreamReq.setTimeout(30_000, () => { upstreamReq.destroy(new Error('upstream timeout')); });`. The destroyed request emits `'error'`, which goes through `mapUpstreamErrorToCode` and yields the standard 502 response.

**Implementation discipline**: both bounds (`MAX_BODY_BYTES = 64 * 1024`, `UPSTREAM_TIMEOUT_MS = 30_000`) live as named constants at the top of `handler.ts` with a short comment explaining each. Tests import the same constants — no magic numbers in assertions.

**Alternatives considered**:
- No limits (option A in Q5): rejected — preserves preceding-script behavior but leaves the proxy as a DoS amplifier into the upstream.
- 8 KiB body, no timeout (option C in Q5): rejected — 8 KiB is too tight (no headroom for future credentialId or schema-version fields), and "no timeout" is the worst failure mode.

**Source**: Clarification Q5.

## R-7: Logging — structured JSON on stdout, only on init and upstream error

**Decision**: Two log events total, both JSON on stdout:
1. `{ "event": "git-token-proxy-init", "listenSocket": "<path>", "upstreamSocket": "<path>" }` — emitted once after a successful bind and `chmod 0660`.
2. `{ "event": "git-token-proxy-upstream-error", "code": "CONTROL_SOCKET_UNREACHABLE" }` — emitted on each upstream failure.

No per-request success log. **No body content, no header content, no token, no upstream response body, no remote IP/uid, no stack trace** in either event.

**Rationale**:
- Per clarification Q3: matches the `@generacy-ai/control-plane` package's existing structured-log convention (`bin/control-plane.ts:111` `{ event: 'store-init', store, ...result }`, `bin/control-plane.ts:150` `{ event: 'store-init', store, status, ...}`). Lets operators grep `event=git-token-proxy-upstream-error` to drive alerts.
- No per-request success log: success is the common case. Logging it adds noise without operational value. The cluster's request-level observability already lives elsewhere (control-plane access logs, FR-010 in #766's git-token telemetry).
- Strict prohibition on bodies/headers in logs is policy, not just convention: a logged response body could contain a token. Tokens MUST NEVER appear in logs (cross-reference #766's data-model.md "Token never logged.").

**Implementation**: small helper module `src/git-token-proxy/logging.ts` exporting two functions, `logProxyInit({ listenSocket, upstreamSocket })` and `logUpstreamError({ code })`. Each takes a typed argument object and `JSON.stringify`s the literal shape with no spread, so no accidental field leakage is possible. Tests assert the exact emitted JSON.

**Bind-failure handling**: bind failure writes a single structured-but-stderr line `git-token-proxy: bind failed: <path>: <errno>` and exits non-zero. Stderr (not stdout) because bind failure is an init error, not a steady-state observability event. Matches clarification Q1's "structured stderr line that names the missing path."

**Alternatives considered**:
- Plain-text lines on stderr (option B in Q3): rejected — inconsistent with control-plane's own log style and harder to grep machine-side.
- Silent on success / log only failures (option C in Q3): rejected — operators need a positive signal that the proxy is up. Init log fills that role.
- Per-request log line (event=request, result=ok / 404 / 413 / 502): rejected — high volume, low signal, body-leakage risk.

**Source**: Clarification Q3.

## R-8: Parent-directory ownership — cluster-base, not the bin

**Decision**: The bin does not `mkdir` and does not probe the listen-socket's parent directory. On bind failure, it writes a structured stderr line that names the missing path and exits non-zero. Cluster-base entrypoint owns the `/run/generacy-git-token/` tmpfs lifecycle.

**Rationale (clarification Q1)**:
- cluster-base already owns the lifecycle of `/run/generacy-control-plane/` (the upstream socket's parent), via tmpfs mount entries in `docker-compose.yml`. Owning the new `/run/generacy-git-token/` tmpfs in the same place is the only consistent answer.
- If the bin also tried `mkdir`, it would race the entrypoint and need an opinion about owner/mode/SELinux context — none of which is its concern. Better to fail loudly with a clear message and let cluster-base be the single point of repair.
- Mirrors `git-credential-generacy`'s pattern (it does no path setup either; it just `http.request({ socketPath, … })` and lets the OS surface bind errors as `ENOENT`/`ECONNREFUSED`).

**Failure shape**: `git-token-proxy: bind failed: /run/generacy-git-token/control.sock: ENOENT` to stderr, exit code non-zero. Operators see immediately which path the entrypoint must create.

**Alternatives considered**:
- Bin `mkdirSync(dirname, { recursive: true, mode: 0o2770 })` (option B in Q1): rejected. Race with entrypoint, ownership and SELinux concerns leak into application code, and the proxy gains a responsibility unrelated to its function.
- Probe-then-fail with a more elaborate precondition check (option C in Q1): rejected. The bind itself is the precondition check — `listen()` will fail with `ENOENT`/`EACCES` and we capture that. No need to do it twice.

**Source**: Clarification Q1.

## R-9: Stale-socket cleanup and lifecycle (SIGTERM, SIGINT)

**Decision**:
- **At boot**: `await unlinkIfExists(listenSocketPath)` before `server.listen()`. `EBUSY` / `EPERM` is treated as a fatal error (some other process owns it — fail loudly).
- **On `SIGTERM` / `SIGINT`**: `server.close(...)` to stop accepting new connections, then `await fs.unlink(listenSocketPath).catch(noop)`, then `process.exit(0)`. 5 s timeout after which `process.exit(1)` if `close` hasn't returned.

**Rationale**:
- Stale-socket cleanup matches the existing script (spec §Scope) and is required to allow restart after an unclean shutdown (Docker SIGKILL leaves the inode behind).
- Explicit unlink on graceful shutdown ensures the next process's `unlinkIfExists` finds nothing — cleaner than relying on the cleanup-at-boot belt-and-suspenders alone, and aids the smoke test (R-10) which asserts the socket file disappears after SIGTERM.
- 5 s grace timeout because the proxy has zero outstanding work in steady state — the connections are sub-second. If `close` doesn't return in 5 s, something is wrong; favor exit over hang.

**Implementation**:
```ts
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  setTimeout(() => process.exit(1), 5_000).unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.unlink(listenSocketPath).catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT',  () => { void shutdown('SIGINT'); });
```

**Source**: Spec §Scope, clarification Q4 (smoke-test coverage).

## R-10: Test split — pure functions plus one real-socket smoke

**Decision** (restating clarification Q4 in implementation terms):
- **Pure-function tests** (`handler.test.ts`, `allowlists.test.ts`, `upstream-errors.test.ts`) cover the security-critical logic. They run on every CI, every platform, in milliseconds. Each test is a literal restatement of policy:
  - `isAllowedRoute('GET', '/git-token')` → `false`
  - `isAllowedRoute('POST', '/git-token')` → `true`
  - `isAllowedRoute('POST', '/git-token/')` → `false` (trailing slash significant)
  - `isAllowedRoute('POST', '/git-token?x=y')` → `true` (query stripped)
  - `isAllowedRoute('POST', '/credentials/foo')` → `false`
  - `isAllowedRoute('POST', '/git-token/../credentials/foo')` → `false` (URL parsing normalizes)
  - `pickAllowedHeaders({ 'content-type': 'application/json', 'content-length': '2', 'authorization': 'Bearer x', 'x-foo': 'y', host: 'z' })` → `{ 'content-type': 'application/json', 'content-length': '2' }`
  - `mapUpstreamErrorToCode(<ECONNREFUSED>)` → `'CONTROL_SOCKET_UNREACHABLE'` (same for ENOENT, EPIPE, ECONNRESET, timeout, any Error)
- **One real-Unix-socket smoke test** (`lifecycle.smoke.test.ts`) covers what pure functions can't: bind in a tmp dir, `0660` socket mode (`(stat.mode & 0o777) === 0o660`), single-route enforcement on the wire (real `http.request({ socketPath, method, path })` for `GET /git-token`, `POST /other`, `POST /git-token` against a fake upstream socket), `SIGTERM` deletes the socket file. Wraps `describe.skipIf(process.platform === 'win32', …)` (vitest helper) so non-POSIX CI lanes pass.

**Why hybrid (not all-mock, not all-integration)**:
- All-mock would miss the wire-level allow-list enforcement: a bug where the handler's `isAllowedRoute` check is silently bypassed by a code-path that doesn't call it (e.g., a 405 handler that forwards anyway) would slip through pure-function tests but be caught by the smoke test.
- All-integration would be slow, hard to reason about edge cases for, and skip non-POSIX CI. The pure-function tests are the day-to-day signal; the smoke test is the wire-level confidence check.
- A privilege boundary deserves more than one test angle — this is what "hybrid" buys.

**Source**: Clarification Q4.

## R-11: Binary distribution and PATH

**Decision**: `packages/control-plane` `package.json` `bin` field gains a third entry: `"git-token-proxy": "./dist/bin/git-token-proxy.js"`. Inside the cluster image, the companion cluster-base PR launches the bin by absolute path from `/shared-packages/node_modules/@generacy-ai/control-plane/dist/bin/git-token-proxy.js` (mirroring how `git-credential-generacy` is referenced today).

**Rationale**:
- Shipping from the same package as `control-plane` and `git-credential-generacy` keeps the proxy version-locked to the route and the CLI it sits between.
- Absolute-path invocation from cluster-base avoids `$PATH` ambiguity and matches the existing pattern for cluster-side bins (see `git-credential-generacy` discussion in #766 R-10).
- Three bins in one package is the right granularity. `git-token-proxy` is too small to justify its own package, and its release cadence is identical to the route's.

**Why not a CLI shim**: the bin is the CLI. No shim layer needed.

**Source**: Spec §Scope (path `@generacy-ai/control-plane/dist/bin/git-token-proxy.js`).

## R-12: What we deliberately are not doing in this issue

- **Not** modifying cluster-base. The companion PR ships the launch wiring and removes the bundled script.
- **Not** changing the control-plane `POST /git-token` route. The proxy forwards bytes; the route's shape is owned by #766.
- **Not** introducing per-worker authentication on the listen socket. The privilege boundary is filesystem permission (`0660` + correct uid/gid on the socket file). Adding bearer auth between worker and proxy would be ceremony with no security uplift — the worker already shares the socket's group; if its uid is compromised, so is everything else in the worker container.
- **Not** adding a `CONTROL_SOCKET_UNREACHABLE` distinction between "upstream socket file missing" and "upstream socket file present but connection refused." Same code, same remediation (R-5).
- **Not** adding retries on upstream failure. The proxy is a transport layer; retries belong in the caller's policy. Adding retries here would mask transient cloud-pull failures and contradict #766's loud-failure design.
- **Not** adding rate-limiting. The bin runs colocated with the workers it serves; rate-limiting attempts inside the same trust boundary buys nothing.

## References

- `packages/control-plane/bin/git-credential-generacy.ts` — sibling bin and pattern source (HTTP-over-Unix-socket client; structured exit codes).
- `packages/control-plane/bin/control-plane.ts:22-43` — structured-log shape this proxy mirrors (`console.log(JSON.stringify({ event: '...' }))`).
- `packages/control-plane/src/routes/git-token.ts` — the upstream route the proxy forwards to (#766).
- `packages/control-plane/__tests__/bin/git-credential-generacy.test.ts` — test-style precedent for bin testing in this package.
- generacy-ai/generacy#766 — the JIT credential helper feature this proxy completes.
- generacy-ai/cluster-base#61 — the companion image-side wiring (launches the new bin, removes the bundled script).
- [git-credential(1) — IOFMT](https://git-scm.com/docs/git-credential) — cross-reference: the wrapper protocol this proxy ultimately serves.
