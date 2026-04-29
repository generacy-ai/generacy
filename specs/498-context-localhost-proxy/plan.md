# Implementation Plan: localhost-proxy Exposure Listener

**Feature**: Implement real localhost-proxy exposure listener for credhelper daemon
**Branch**: `498-context-localhost-proxy`
**Status**: Complete

## Summary

Replace the current stub `renderLocalhostProxy` in `ExposureRenderer` with a real HTTP reverse proxy that:
1. Listens on `127.0.0.1:<port>` (static port from role config)
2. Enforces a method+path allowlist from the role's `proxy:` block
3. Injects upstream auth headers from the plugin's `renderExposure` output
4. Returns 403 JSON errors for disallowed requests
5. Passes through upstream errors as-is
6. Manages lifecycle per-session (start on begin, stop on end)

## Technical Context

- **Language**: TypeScript (ESM, strict mode)
- **Runtime**: Node.js >=20
- **Package**: `packages/credhelper-daemon`
- **Framework**: Native `node:http` (no Express, consistent with daemon pattern)
- **Test Framework**: Vitest
- **Dependencies**: None new — uses `node:http`, `node:url`, `node:https` only

## Project Structure

```
packages/credhelper-daemon/
├── src/
│   ├── exposure/
│   │   └── localhost-proxy.ts          # NEW — LocalhostProxy class + handler
│   ├── exposure-renderer.ts            # MODIFY — wire real proxy, return handle
│   ├── session-manager.ts              # MODIFY — store/cleanup proxy handles, validate proxy config
│   ├── types.ts                        # MODIFY — add LocalhostProxyHandle, update SessionState
│   └── errors.ts                       # MODIFY — add PROXY_PORT_COLLISION, PROXY_CONFIG_MISSING error codes
├── __tests__/
│   ├── exposure/
│   │   └── localhost-proxy.test.ts     # NEW — unit tests for proxy handler + path matching
│   └── integration/
│       └── localhost-proxy.test.ts     # NEW — integration test: happy path, deny, teardown
packages/credhelper/
├── src/schemas/
│   └── roles.ts                        # MODIFY — add envName to RoleExposeSchema
```

## Implementation Steps

### Step 1: Add error codes and types

**Files**: `src/errors.ts`, `src/types.ts`

- Add `PROXY_PORT_COLLISION` and `PROXY_CONFIG_MISSING` to `ErrorCode` union
- Add HTTP status mappings (409 for port collision, 400 for config missing)
- Add `LocalhostProxyHandle` interface (mirrors `DockerProxyHandle`: `stop(): Promise<void>`)
- Add `localhostProxies?: LocalhostProxyHandle[]` to `SessionState`

### Step 2: Add `envName` to exposure schema

**File**: `packages/credhelper/src/schemas/roles.ts`

- Add `envName: z.string().optional()` to `RoleExposeSchema`

### Step 3: Create LocalhostProxy class

**File**: `src/exposure/localhost-proxy.ts` (new)

Core class following `DockerProxy` pattern:

```typescript
export class LocalhostProxy implements LocalhostProxyHandle {
  private server: http.Server | null = null;

  constructor(config: LocalhostProxyConfig) {}

  async start(): Promise<void>   // Bind to 127.0.0.1:port, fail on EADDRINUSE
  async stop(): Promise<void>    // Close server, null out
}
```

**Handler logic** (`createLocalhostProxyHandler`):
1. Parse incoming request URL, strip query string
2. Match method (exact, case-insensitive uppercase) + path against allowlist
3. Path matching: literal segments match exactly; `{param}` matches any single non-empty segment
4. On no match → 403 JSON `{ error, code: 'PROXY_ACCESS_DENIED', details: { method, path } }`
5. On match → create outbound request to `upstream + path + querystring`, inject auth headers, pipe request body, pipe response back
6. On upstream error → pass through status + body as-is

**Path matching algorithm**:
- Split pattern and request path by `/`
- Segment count must match exactly (trailing slash = significant)
- Each segment: literal match (case-sensitive) or `{param}` matches any non-empty string
- Query string stripped from request URL before matching

### Step 4: Modify ExposureRenderer

**File**: `src/exposure-renderer.ts`

- Change `renderLocalhostProxy` signature to accept proxy config (allowlist rules, port) and return `LocalhostProxyHandle`
- New signature: `async renderLocalhostProxy(sessionDir, data, proxyConfig, port): Promise<LocalhostProxyHandle>`
- Create `LocalhostProxy` instance, call `.start()`, return handle
- Still write `proxy/config.json` for debugging/introspection
- Write env var entry for proxy URL

### Step 5: Modify SessionManager

**File**: `src/session-manager.ts`

In `beginSession()`:
- Before plugin rendering, validate: if any credential uses `as: localhost-proxy`, verify `roleConfig.proxy?.[credRef.ref]` exists. If missing, throw `PROXY_CONFIG_MISSING` error naming the key.
- When rendering `localhost-proxy` exposure:
  - Look up `roleConfig.proxy![credRef.ref]` for allowlist rules
  - Pass to renderer along with plugin exposure data
  - Collect returned `LocalhostProxyHandle` into array
  - Write env var: `envName ?? <REF_UPPER>_PROXY_URL` = `http://127.0.0.1:<port>`

In `endSession()`:
- Stop all localhost proxy handles (before data server close)

Update `SessionState` to include `localhostProxies` field.

### Step 6: Unit tests

**File**: `__tests__/exposure/localhost-proxy.test.ts`

- Path matching: literal paths, `{param}` placeholders, trailing slash significance, query string stripping, case sensitivity
- Method matching: exact match, wrong method → 403
- Handler: allowed request forwards correctly, denied request returns 403 JSON
- Port collision: EADDRINUSE surfaces clear error
- Secret not in logs (verify no console output contains secret value)

### Step 7: Integration tests

**File**: `__tests__/integration/localhost-proxy.test.ts`

- **Happy path**: Start session with SendGrid role, POST to proxy, verify upstream receives request with auth header, verify response forwarded back
- **Default deny**: GET to allowed POST-only path → 403; arbitrary path → 403
- **Teardown**: End session, verify port is released (can bind again)
- **Validation**: Missing `proxy:` entry → session creation fails with `PROXY_CONFIG_MISSING`
- **Env var**: Verify session env file contains proxy URL

## Key Design Decisions

1. **Follow DockerProxy pattern**: `LocalhostProxy` class with `start()/stop()`, handle stored in `SessionState`, cleanup in `endSession()`. Proven pattern, consistent with codebase.

2. **Array of handles** (not single): A session may have multiple credentials each with `localhost-proxy` exposure on different ports. Use `localhostProxies: LocalhostProxyHandle[]`.

3. **Native `node:http` for upstream forwarding**: Use `http.request()` / `https.request()` to forward to upstream. No external HTTP client dependency. Parse upstream URL to determine http vs https module.

4. **Path matching is a pure function**: `matchAllowlist(method, path, rules)` is exported and independently testable. No class state needed.

5. **Fail-closed on everything**: Missing proxy config, port collision, unmatched request — all fail closed with descriptive errors.

6. **No secret logging**: Auth headers are injected into the outbound request but never logged. The proxy handler must not log request/response headers.

## Constitution Check

No `.specify/memory/constitution.md` found. No governance constraints to verify.

## Dependencies

- No new npm packages
- Depends on `@generacy-ai/credhelper` types (already a workspace dependency)
- Node.js built-in modules: `node:http`, `node:https`, `node:url`

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Port collision between sessions | Session start fails | Fail-closed with clear error; port is from role config |
| Leaked listeners on crash | Port stays bound | Daemon `endAll()` in shutdown path already handles this |
| Large request bodies | Memory pressure | Stream request/response with `pipe()`, don't buffer |
