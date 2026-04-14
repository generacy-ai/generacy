# Research: Scoped Docker Socket Proxy

## Technology Decisions

### Unix socket proxying with Node.js built-in `http` module

**Decision**: Use `http.createServer()` for the proxy socket and `http.request()` with `socketPath` for forwarding to the upstream Docker daemon.

**Rationale**: The Docker API is HTTP-over-Unix-socket. Node's `http` module natively supports Unix sockets on both sides — `server.listen('/path/to/socket')` for accepting connections and `http.request({ socketPath: '/path/to/upstream' })` for forwarding. This gives us HTTP-level request inspection (method, path, headers, query string) which is exactly what allowlist enforcement requires.

**Alternatives considered**:
- **Raw TCP proxying (`net.createServer`)**: Would require manual HTTP parsing or an external parser. Loses the ability to inspect requests at the HTTP level without significant extra code. Only useful if we needed to proxy non-HTTP protocols over the socket.
- **Express/Koa middleware**: Overkill for a proxy that needs custom forwarding logic. These frameworks are designed for building APIs, not proxying. Would add dependencies for no benefit.
- **`http-proxy` npm package**: Full-featured HTTP proxy library. However, it's designed for TCP/HTTP proxying between network endpoints, not Unix socket proxying. Its API doesn't align well with our allowlist-then-forward pattern. Bringing our own `http.request()` forwarding is simpler and more transparent.

**Implementation pattern**:
```typescript
// Proxy socket (accepts Docker client connections)
const proxyServer = http.createServer(handleRequest);
proxyServer.listen(sessionDockerSocketPath);

// Forwarding to upstream
function forwardToUpstream(clientReq, clientRes, upstreamSocketPath) {
  const upstreamReq = http.request({
    socketPath: upstreamSocketPath,
    method: clientReq.method,
    path: clientReq.url,
    headers: clientReq.headers,
  }, (upstreamRes) => {
    clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(clientRes);
  });
  clientReq.pipe(upstreamReq);
}
```

### `picomatch` for container name glob matching

**Decision**: Use `picomatch` for matching container names against glob patterns in Docker allowlist rules.

**Rationale**: The `name` field in `DockerRule` uses glob patterns like `firebase-*`. `picomatch` is:
- Zero runtime dependencies
- Well-tested (used by Chokidar, Micromatch, fast-glob)
- Supports standard glob syntax (`*`, `?`, `**`, brace expansion)
- Compiles patterns to regex for O(1) matching after compilation
- Much smaller than `minimatch` (which has a `brace-expansion` dependency)

**Alternatives considered**:
- **`minimatch`**: npm's standard glob library. Works fine but has a transitive dependency on `brace-expansion`. Slightly heavier than needed for simple patterns like `firebase-*`.
- **Custom regex**: Could convert `*` → `.*` and `?` → `.` manually. But glob semantics have edge cases (escaping, character classes) that are easy to get wrong. Not worth the risk for a security-critical path.
- **`micromatch`**: Wrapper around `picomatch` with extra features. We only need `isMatch()`, so going direct to `picomatch` is cleaner.

**Usage pattern**:
```typescript
import picomatch from 'picomatch';

const isMatch = picomatch('firebase-*');
isMatch('firebase-emulator');  // true
isMatch('redis');              // false
```

### Docker API version prefix stripping

**Decision**: Strip `/v<N.NN>` prefix from incoming request paths before matching against allowlist rules.

**Rationale**: Docker clients (including the Docker CLI) prefix API paths with a version string like `/v1.41/containers/json`. Role configs use unversioned paths (`/containers/json`) for readability and forward-compatibility. The proxy normalizes by stripping the prefix: `requestPath.replace(/^\/v\d+\.\d+/, '')`.

This matches the clarification Q1 answer and is consistent with how other docker-socket-proxy implementations handle versioning (e.g., Tecnativa/docker-socket-proxy uses haproxy ACLs on unversioned paths).

**Implementation**:
```typescript
function normalizePath(rawPath: string): string {
  return rawPath.replace(/^\/v\d+\.\d+/, '');
}
// '/v1.41/containers/json' → '/containers/json'
// '/containers/json' → '/containers/json' (no-op)
```

### Path template matching with `{id}` extraction

**Decision**: Compile allowlist path patterns containing `{id}` into regex patterns that extract the container ID.

**Rationale**: Docker API paths like `/containers/{id}/start` need to match requests like `/containers/abc123def/start`. The `{id}` placeholder matches any non-slash segment. The extracted ID is needed for container name resolution when the rule has a `name` glob.

**Implementation**:
```typescript
function compilePathPattern(pattern: string): { regex: RegExp; hasId: boolean } {
  const hasId = pattern.includes('{id}');
  // Escape regex special chars, then replace {id} with capture group
  const regexStr = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape special chars
    .replace('\\{id\\}', '([^/]+)');          // replace {id} with capture
  return { regex: new RegExp(`^${regexStr}$`), hasId };
}
```

### Upstream socket auto-detection

**Decision**: Detect the upstream Docker socket once at daemon boot using a priority-ordered check.

**Rationale**: The spec defines a clear priority order (decision #16):
1. DinD: `ENABLE_DIND=true` AND `/var/run/docker.sock` reachable
2. DooD: `/var/run/docker-host.sock` mounted
3. Neither: fail closed

Detecting once at boot (rather than per-session) is correct because the upstream doesn't change during the daemon's lifetime. It also enables fail-fast — if no Docker socket is available and roles need it, the daemon can report this immediately.

**Implementation**:
```typescript
async function detectUpstreamSocket(): Promise<string> {
  if (process.env.ENABLE_DIND === 'true') {
    try {
      await fs.access('/var/run/docker.sock', fs.constants.W_OK);
      return '/var/run/docker.sock';
    } catch { /* fall through */ }
  }
  try {
    await fs.access('/var/run/docker-host.sock', fs.constants.W_OK);
    return '/var/run/docker-host.sock';
  } catch { /* fall through */ }
  throw new CredhelperError('DOCKER_UPSTREAM_NOT_FOUND',
    'No Docker socket found: checked /var/run/docker.sock (DinD) and /var/run/docker-host.sock (DooD)');
}
```

### Streaming restriction for `follow=true`

**Decision**: Parse the query string on `GET /containers/{id}/logs` and reject requests with `follow=true`.

**Rationale**: Docker logs with `follow=true` creates an unbounded streaming response. This is out of scope for Phase 3 (same category as attach/exec). Standard log requests without `follow` use chunked transfer encoding which the proxy handles transparently via stream piping.

**Implementation**:
```typescript
function isFollowLogsRequest(method: string, normalizedPath: string, rawUrl: string): boolean {
  if (method !== 'GET') return false;
  if (!/^\/containers\/[^/]+\/logs$/.test(normalizedPath)) return false;
  const url = new URL(rawUrl, 'http://localhost');
  return url.searchParams.get('follow') === 'true' || url.searchParams.get('follow') === '1';
}
```

## Implementation Patterns

### Allowlist matching algorithm

```
For each incoming request:
  1. Normalize path (strip version prefix)
  2. Check follow=true streaming restriction
  3. For each rule in allowlist:
     a. Check method matches
     b. Check normalized path matches compiled pattern
     c. If pattern has {id} and rule has name glob:
        - Extract container ID from path
        - Resolve ID → name via upstream Docker API (cached)
        - If resolution fails → deny (fail closed)
        - Glob match name against rule.name pattern
     d. If all checks pass → ALLOW
  4. No rule matched → DENY (default deny)
```

### Request forwarding with stream piping

```typescript
// No buffering — stream pipe handles chunked encoding
clientReq.pipe(upstreamReq);
upstreamRes.pipe(clientRes);
```

This is critical for Docker responses that use chunked transfer encoding (e.g., log output, container listings with many containers). Node.js streams handle backpressure automatically.

### Security warning logging

```typescript
const DANGEROUS_PATHS = [
  'POST /containers/create',
  'POST /exec',
  'POST /build',
];

function logSecurityWarning(method: string, path: string, upstreamIsHost: boolean) {
  const key = `${method} ${path}`;
  if (DANGEROUS_PATHS.some(d => key.startsWith(d)) && upstreamIsHost) {
    console.warn(`[credhelper] SECURITY: forwarding ${key} to host Docker socket`);
  }
}
```

## Key Sources

- **Spec**: `specs/464-credentials-architecture/spec.md`
- **Clarifications**: `specs/464-credentials-architecture/clarifications.md` (5 resolved questions)
- **Phase 1 schemas**: `packages/credhelper/src/schemas/roles.ts` — `DockerRuleSchema`, `DockerConfigSchema`
- **Phase 2 daemon**: `packages/credhelper-daemon/src/` — session lifecycle, exposure renderer stub
- **Tecnativa/docker-socket-proxy**: Reference implementation in haproxy; conceptual model for allowlist-based Docker API filtering
- **Docker Engine API**: REST API over Unix socket; versioned paths; chunked responses
- **picomatch**: Glob matching library — https://github.com/micromatch/picomatch
- **Node.js `http.request` socketPath**: https://nodejs.org/api/http.html#httprequestoptions-callback
