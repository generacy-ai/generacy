# Data Model: Worker-side git-token proxy bin

This bin is **stateless**. No on-disk state, no in-memory cache, no per-request mutable structure beyond the small bag of values used to forward one request to upstream. The "data model" here is the small set of TypeScript types and a handful of named constants that bound the proxy's behavior.

## Constants

```ts
/** Maximum allowed request body size in bytes. Overflow → 413. */
export const MAX_BODY_BYTES = 64 * 1024; // 64 KiB — clarification Q5

/** Upstream response timeout. Overrun → 502 CONTROL_SOCKET_UNREACHABLE. */
export const UPSTREAM_TIMEOUT_MS = 30_000; // 30 s — clarification Q5

/** Listen-socket file permissions. */
export const LISTEN_SOCKET_MODE = 0o660;

/** Default listen socket path. Overridable via env GIT_TOKEN_PROXY_SOCKET. */
export const DEFAULT_LISTEN_SOCKET = '/run/generacy-git-token/control.sock';

/** Default upstream socket path. Overridable via env CONTROL_PLANE_SOCKET_PATH. */
export const DEFAULT_UPSTREAM_SOCKET = '/run/generacy-control-plane/control.sock';

/** Graceful shutdown timeout — if server.close() doesn't return, force exit. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;
```

All bounds documented in the bin source (`handler.ts` for the request-side ones, `bin/git-token-proxy.ts` for the lifecycle ones). Tests import these constants directly — no magic numbers in assertions.

## Types

### `ProxyEnv` — resolved at bin startup

```ts
export interface ProxyEnv {
  /** Where the proxy listens (worker-facing). */
  listenSocketPath: string;
  /** Where the proxy forwards (control-plane). */
  upstreamSocketPath: string;
}
```

Built once in `bin/git-token-proxy.ts` from `process.env`. Passed to `handle()` via closure / dependency injection so the handler is testable with arbitrary tmp-dir socket paths.

### `RouteAllowList` (encapsulated as a pure function)

```ts
/**
 * Returns true iff this method+path pair is allowed by the privilege boundary.
 * The only true case is POST /git-token (with optional query string).
 * Trailing slash is significant; query is dropped before comparison.
 */
export function isAllowedRoute(method: string | undefined, url: string | undefined): boolean;
```

Test policy: exhaustive table including positive (`POST /git-token`, `POST /git-token?x=y`) and negative (`GET /git-token`, `POST /git-token/`, `POST /git-tokens`, `POST /credentials/x`, `POST /lifecycle/bootstrap-complete`, `OPTIONS /git-token`, undefined method, undefined url, `POST //git-token`).

### `HeaderAllowList` (encapsulated as a pure function)

```ts
/**
 * Returns a new headers object containing ONLY 'content-type' and 'content-length'
 * (when present in the input). All other keys are dropped. Header names are
 * normalized to lowercase. content-length is the value passed in — the caller is
 * expected to have replaced it with the actual buffered body length.
 */
export function pickAllowedHeaders(headers: http.IncomingHttpHeaders): Record<string, string>;
```

Test policy: every key from a representative dirty input (`host`, `authorization`, `accept`, `cookie`, `x-real-ip`, `x-forwarded-for`, `range`, `if-none-match`, `user-agent`, custom `x-anything`) is excluded; only `content-type` + `content-length` survive. Case-insensitive on input (`Content-Type` and `CONTENT-LENGTH` both honored), always lowercase on output.

### `UpstreamErrorCode` (closed union of one)

```ts
export type UpstreamErrorCode = 'CONTROL_SOCKET_UNREACHABLE';

/**
 * Maps any upstream-side failure (transport error, timeout, socket close) to the
 * single error code this bin emits. Identity function in v1: every input → same output.
 * Tests exercise representative inputs (ENOENT, ECONNREFUSED, ECONNRESET, EPIPE,
 * AbortError from timeout, generic Error).
 */
export function mapUpstreamErrorToCode(err: unknown): UpstreamErrorCode;
```

The single closed-union value is deliberate. The bin does not distinguish between transport failure modes; the CLI wrapper (#766) cares only that the upstream is unreachable. See research R-5.

### `ProxyErrorResponse` (wire shape on error)

```ts
export interface ProxyErrorResponse {
  /** Human-readable message; not parsed by the CLI wrapper but useful for curl-driven debugging. */
  error: string;
  /** Machine-readable code. The wrapper grep target. */
  code: 'PAYLOAD_TOO_LARGE' | 'CONTROL_SOCKET_UNREACHABLE';
}
```

Three response codes the proxy itself produces, with three wire-shape outcomes:

| HTTP status | Body shape | Trigger |
|---|---|---|
| `404 Not Found` | empty body | `isAllowedRoute(req.method, req.url) === false` |
| `413 Payload Too Large` | `{ error, code: 'PAYLOAD_TOO_LARGE' }` | Request body exceeds `MAX_BODY_BYTES` |
| `502 Bad Gateway` | `{ error, code: 'CONTROL_SOCKET_UNREACHABLE' }` | `mapUpstreamErrorToCode` fired (transport / timeout / mid-response close) |

On a 2xx or any non-transport upstream response (4xx from the route itself, 5xx from upstream business logic), the proxy passes through the upstream status code and body verbatim. The proxy is a transport layer; it does not editorialize upstream application-level errors.

### `LogEvent` (closed union of two)

```ts
export type LogEvent =
  | { event: 'git-token-proxy-init'; listenSocket: string; upstreamSocket: string }
  | { event: 'git-token-proxy-upstream-error'; code: UpstreamErrorCode };
```

`src/git-token-proxy/logging.ts` exports exactly two functions that build and emit these shapes:

```ts
export function logProxyInit(args: { listenSocket: string; upstreamSocket: string }): void;
export function logUpstreamError(args: { code: UpstreamErrorCode }): void;
```

Tests assert `console.log` is called once with `JSON.stringify(<the exact object literal>)` and no other calls happen (`expect(console.log).toHaveBeenCalledTimes(1)`).

## Lifecycle

The bin has three lifecycle phases. None of them mutate persistent state.

### 1. Init (one-shot, on process start)

```
parse env (ProxyEnv)
→ unlink(listenSocketPath) if it exists  (stale-socket cleanup; EBUSY/EPERM is fatal)
→ http.createServer(handler) and server.listen({ path: listenSocketPath })  (bind error → structured stderr + exit non-zero, per R-8)
→ fs.chmod(listenSocketPath, 0o660)
→ logProxyInit({ listenSocket, upstreamSocket })
→ register SIGTERM, SIGINT handlers
```

No data structure persists across init. On failure at any step before `chmod`, exit non-zero. The `chmod` failure is fatal (privilege boundary correctness depends on it).

### 2. Steady state (per request)

Each request is independent. No state is shared between requests except the long-lived `http.Server` instance.

```
inbound request (method, url, headers, body stream)
→ isAllowedRoute(method, url)
    false → res.writeHead(404).end()    [no upstream contact]
    true →
        buffer body up to MAX_BODY_BYTES
            overflow → res.writeHead(413).end(JSON.stringify({ error, code: 'PAYLOAD_TOO_LARGE' }))
        outboundHeaders = pickAllowedHeaders(inboundHeaders)
        outboundHeaders['content-length'] = String(body.length)        [recomputed, not copied]
        upstreamReq = http.request({ socketPath: upstreamSocketPath, method: 'POST', path: '/git-token', headers: outboundHeaders })
        upstreamReq.setTimeout(UPSTREAM_TIMEOUT_MS, () => upstreamReq.destroy(new Error('timeout')))
        upstreamReq.write(body); upstreamReq.end()
        upstreamReq.on('response', upstreamRes => {
            res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
            upstreamRes.pipe(res)                                       [transparent passthrough]
        })
        upstreamReq.on('error', err => {
            logUpstreamError({ code: 'CONTROL_SOCKET_UNREACHABLE' })
            res.writeHead(502, { 'content-type': 'application/json' })
                .end(JSON.stringify({ error: 'control-plane upstream unreachable', code: 'CONTROL_SOCKET_UNREACHABLE' }))
        })
```

### 3. Shutdown (on SIGTERM or SIGINT)

```
register SHUTDOWN_TIMEOUT_MS timer (process.exit(1) if it fires)
→ server.close()                                  [stops accepting; lets in-flight requests drain]
→ fs.unlink(listenSocketPath).catch(noop)         [explicit cleanup; next process's stale-cleanup finds nothing]
→ process.exit(0)
```

If `server.close` blocks > `SHUTDOWN_TIMEOUT_MS`, `process.exit(1)` fires from the timeout. The unlink is best-effort (we may have lost the file race; not worth blocking shutdown over).

## Relationships

```
┌──────────────────┐        UDS (0660)         ┌────────────────────┐        UDS         ┌────────────────────┐
│ worker (uid 1001 │  ──── POST /git-token ───▶ │  git-token-proxy   │ ────── POST ─────▶ │  control-plane     │
│ git or wrapper)  │                            │  (this bin)        │      /git-token    │  (existing)        │
└──────────────────┘  ◀──── 200 / 404 / 502 ── └────────────────────┘   ◀── 200 / 5xx ── └────────────────────┘
                                                       │
                                                       │ stdout
                                                       ▼
                                              ┌────────────────────┐
                                              │ JSON log lines     │
                                              │  - init            │
                                              │  - upstream-error  │
                                              └────────────────────┘
```

The proxy is purely on the data path. Token never enters the proxy as a logged value; tokens travel through `body` (in the upstream-success path) as opaque bytes that are written to `res` via `upstreamRes.pipe(res)` without inspection.

## Validation rules

1. **No token in logs.** No code path in `handler.ts` or `logging.ts` may include `body`, `req.headers`, `upstreamRes.headers`, or any string read from the response stream in a log line. The two `LogEvent` shapes are closed; no spread, no dynamic key.
2. **No body parsing.** The handler MUST NOT `JSON.parse(body)`. Body bytes are opaque to the proxy. (The size cap is enforced as a byte count, not a parsed structure.)
3. **No upstream contact on disallowed route.** `isAllowedRoute` must short-circuit the handler before any `http.request` is created. Tested by asserting the injected `http.request` factory is never called when the route is rejected.
4. **Header re-construction, not passthrough.** The handler MUST call `pickAllowedHeaders(...)` and pass that result to `http.request`. It MUST NOT pass `req.headers` (or any object derived from it by spread without filtering) — even if the allow-list happens to drop everything in the test fixture, the code path must be the policy.
5. **`content-length` recomputed.** The outbound `content-length` is `String(bufferedBody.length)`, not the value of the inbound `content-length` header. A hostile worker that sends `content-length: 100` but only 50 bytes (or 1000 bytes) cannot use the proxy to lie to upstream about body length.
6. **No fallback path.** Upstream failure must produce a `502 CONTROL_SOCKET_UNREACHABLE`. The handler MUST NOT have any code path that returns a 200 with a stale or synthetic token on upstream error. (Cross-reference #762 / #766's loud-failure ethos.)
7. **Listen socket mode is exactly `0660`.** Set via `fs.chmod(listenSocketPath, LISTEN_SOCKET_MODE)` after `listen()`. The smoke test (`lifecycle.smoke.test.ts`) asserts `(stat.mode & 0o777) === 0o660`.

## What is NOT modeled

- **No retry policy.** Upstream failure is final for this request. The CLI wrapper or the caller decides whether to retry.
- **No connection pool.** Each request opens a fresh upstream `http.request`. Unix sockets make this cheap; pooling would add lifecycle complexity for no benefit at the proxy's call volume.
- **No per-worker identity.** The proxy does not stamp `x-worker-id` or any other header onto upstream requests. If we ever need that, it would be a separate spec change.
- **No metrics surface.** The structured logs are the observability surface. A Prometheus exporter or similar is deferred until oncall asks for it.
- **No relay-event emission.** Unlike the control-plane itself, this bin does not push events on `cluster.*` channels. Bind failure goes to stderr; upstream errors go to stdout JSON; that's it.
- **No graceful drain of in-flight requests on SIGTERM.** `server.close` stops accepting and lets in-flight requests finish, bounded by `SHUTDOWN_TIMEOUT_MS`. The proxy does not actively drain or wait for upstream to confirm — at the proxy's per-request latency (sub-second) this is moot, and a long-running upstream call is exactly what the upstream-timeout (R-6) is for.
