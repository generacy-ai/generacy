# Research: Cluster-relay protocol additions and path-prefix dispatcher

## Technology Decisions

### 1. Unix Socket HTTP Transport

**Decision**: Use Node.js built-in `http.request()` with `socketPath` option.

**Rationale**: The native `fetch()` API (undici) does not support Unix domain sockets. Node's `http` module supports `socketPath` natively, which is the standard approach for HTTP-over-Unix-socket in Node.js.

**Alternatives considered**:
- **undici dispatcher**: undici (Node's fetch backend) supports a `Agent` with custom connect options, but the API is not stable and would add complexity.
- **got/axios with Unix socket support**: Would add a new dependency. The `credhelper-daemon` package already uses `node:http` for the same pattern — follow the established codebase convention.

**Pattern (from credhelper-daemon)**:
```typescript
import { request } from 'node:http';

const req = request({
  socketPath: '/run/generacy-control-plane/control.sock',
  path: '/api/setup',
  method: 'POST',
  headers: { 'content-type': 'application/json' },
}, (res) => { /* handle response */ });
```

### 2. Dispatcher Architecture

**Decision**: Separate `dispatcher.ts` file with pure functions.

**Rationale**: Keeps routing logic testable in isolation from HTTP transport concerns. `proxy.ts` remains responsible for executing HTTP requests; `dispatcher.ts` handles route resolution only.

**Alternatives considered**:
- **Inline in proxy.ts**: Would make proxy.ts too large and harder to test routing logic independently.
- **Class-based Router**: Over-engineered for a static route table. Pure functions are simpler and sufficient.

### 3. Longest-Prefix-Match Strategy

**Decision**: Sort routes by prefix length descending at config load time; first match wins.

**Rationale**: Matches nginx `location` semantics. Pre-sorting means O(n) lookup per request with guaranteed most-specific match. No need for a trie — route count will be small (2-5 entries typically).

**Implementation**:
```typescript
function sortRoutes(routes: RouteEntry[]): RouteEntry[] {
  return [...routes].sort((a, b) => b.prefix.length - a.prefix.length);
}
```

### 4. Actor Header Propagation

**Decision**: Map actor fields to HTTP headers with `x-generacy-` prefix.

**Headers**:
- `x-generacy-actor-user-id` — always set when actor is present
- `x-generacy-actor-session-id` — only set when sessionId is provided

**Rationale**: HTTP headers are the standard mechanism for passing identity context to downstream services in a reverse-proxy architecture. The `x-generacy-` prefix avoids collisions.

### 5. Config Evolution Strategy

**Decision**: Add `routes` array alongside existing `orchestratorUrl`.

**Rationale**: Zero migration path needed. Existing configs without `routes` behave identically to today. The dispatcher checks `routes` first, then falls back to `orchestratorUrl`. This matches the clarification decision (Q3-A).

### 6. Prefix Path Stripping

**Decision**: Strip matched prefix before forwarding.

**Implementation detail**: After matching `/control-plane/` against path `/control-plane/api/setup`, forward to downstream as `/api/setup`. Ensure leading slash is preserved (if the stripped path is empty, forward as `/`).

**Edge cases**:
- Path equals prefix exactly (e.g., `/control-plane/` → `/`)
- Path with query string (preserve query string after stripping)
- Trailing slash normalization (prefix `/control-plane` should match `/control-plane/foo` and `/control-plane`)

### 7. Unix Socket Target URI Scheme

**Decision**: Use `unix://` scheme in config to distinguish from HTTP targets.

**Example config**:
```typescript
routes: [
  { prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' },
  { prefix: '/monitoring', target: 'http://localhost:9090' },
]
```

**Detection**: `target.startsWith('unix://')` → extract socket path → use `http.request({ socketPath })`.

## Key References

- **credhelper-daemon HTTP-over-Unix-socket**: `packages/credhelper-daemon/src/` — Uses same `node:http` + `socketPath` pattern.
- **Existing proxy.ts**: `packages/cluster-relay/src/proxy.ts` — Current single-target forwarding with `fetch()`.
- **Zod discriminated unions**: Existing `RelayMessageSchema` in `messages.ts` — Pattern for extending discriminated unions with optional fields.
- **nginx location matching**: Standard longest-prefix semantics used as reference for dispatcher behavior.
