# Research: localhost-proxy Exposure Listener

## Technology Decisions

### 1. Native `node:http` for proxy forwarding

**Decision**: Use `node:http.request()` / `node:https.request()` to forward requests to upstream APIs.

**Rationale**: The credhelper-daemon has zero external HTTP dependencies — it uses native `node:http` for the control server, data server, and Docker proxy. Adding `http-proxy`, `node-http-proxy`, or similar would break this pattern. The proxy requirements are simple (forward request, inject headers, pipe response) and don't need middleware.

**Alternatives considered**:
- `http-proxy` npm package: Heavyweight, adds dependency, unnecessary for simple header injection + forwarding
- `undici` / `fetch`: Would work but adds a dependency; native http gives streaming control for large bodies
- `node:http2`: Overkill — upstream SaaS APIs use HTTP/1.1; proxy listener is localhost-only

### 2. Path matching: segment-based with `{param}` placeholders

**Decision**: Split path by `/`, compare segment-by-segment. `{param}` matches any single non-empty segment. Exact segment count required (trailing slashes are significant).

**Rationale**: Matches the credentials-architecture-plan.md examples. Simple, no regex compilation needed (though regex is an option). Predictable behavior — role authors can reason about what matches.

**Alternatives considered**:
- Full regex patterns: Too powerful, easy to write overly permissive rules
- path-to-regexp (Express-style): External dependency, more features than needed
- Glob patterns: Ambiguous semantics for URL paths

### 3. Array of proxy handles in SessionState

**Decision**: Store `localhostProxies: LocalhostProxyHandle[]` rather than a single optional handle.

**Rationale**: A session may expose multiple credentials as `localhost-proxy` on different ports (e.g., SendGrid on 7823, Mailgun on 7824). Each gets its own listener. The Docker proxy is a single shared instance because all Docker rules share one socket, but localhost proxies are per-credential with distinct ports.

### 4. Env var for proxy discovery

**Decision**: Write `<envName>=http://127.0.0.1:<port>` to the session env file. `envName` from expose rule, falling back to `<CREDENTIAL_REF_UPPER>_PROXY_URL`.

**Rationale**: Agents consume env vars (not config files). The `env` exposure writes to the same session env file. Explicit `envName` lets role authors match the SDK's expected env var (e.g., `SENDGRID_API_URL`).

## Implementation Patterns

### Request forwarding pattern

```typescript
// Parse upstream URL to determine protocol
const upstreamUrl = new URL(upstream);
const transport = upstreamUrl.protocol === 'https:' ? https : http;

// Forward request
const proxyReq = transport.request({
  hostname: upstreamUrl.hostname,
  port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
  path: req.url,  // preserves query string
  method: req.method,
  headers: { ...req.headers, ...injectedHeaders, host: upstreamUrl.host },
});

req.pipe(proxyReq);

proxyReq.on('response', (proxyRes) => {
  res.writeHead(proxyRes.statusCode, proxyRes.headers);
  proxyRes.pipe(res);
});
```

### Path matching pattern

```typescript
function matchPath(pattern: string, requestPath: string): boolean {
  const patternParts = pattern.split('/');
  const pathParts = requestPath.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) =>
    part.startsWith('{') && part.endsWith('}')
      ? pathParts[i].length > 0
      : part === pathParts[i]
  );
}
```

### Lifecycle pattern (from DockerProxy)

```
Session begin → LocalhostProxy.start() → server.listen('127.0.0.1', port)
Session end   → LocalhostProxy.stop()  → server.close()
```

No socket file to clean up (TCP, not Unix socket), but server must be closed to release the port.

## Key Sources

- Credentials architecture plan: `tetrad-development/docs/credentials-architecture-plan.md`
- DockerProxy reference implementation: `packages/credhelper-daemon/src/docker-proxy.ts`
- ExposureRenderer current stub: `packages/credhelper-daemon/src/exposure-renderer.ts:125-142`
- Session manager lifecycle: `packages/credhelper-daemon/src/session-manager.ts`
- Role schema with proxy block: `packages/credhelper/src/schemas/roles.ts`
- Clarifications (fail-closed, env var, path matching): `specs/498-context-localhost-proxy/clarifications.md`
