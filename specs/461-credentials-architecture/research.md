# Research: Credhelper Daemon

## Technology Decisions

### HTTP-over-Unix-socket (Node built-in `http` module)

**Decision**: Use `http.createServer()` bound to Unix socket paths for both control and data servers.

**Rationale**: The spec originally said "JSON-over-Unix-socket" for the control channel, but clarification Q1 resolved this — HTTP-over-Unix-socket for both. Node's `http` module supports Unix sockets natively by passing a `path` to `server.listen()`. This gives us URL-based routing, status codes, content-length framing, and standard `http.request()` clients for free.

**Alternatives considered**:
- **Express**: Overkill for 2-3 routes per server. Adds a dependency. The daemon doesn't need middleware, CORS, body parsing beyond `JSON.parse()`, or any Express features.
- **Newline-delimited JSON (NDJSON)**: Would need custom framing, routing, and error handling. Zero benefit over HTTP which provides all of this out of the box.
- **gRPC over Unix socket**: Too heavy. Requires protobuf definitions, code generation, and a gRPC runtime. The API surface is tiny.

**Implementation pattern**:
```typescript
const server = http.createServer((req, res) => {
  // Route based on req.method + req.url
});
server.listen('/run/generacy-credhelper/control.sock');
```

### SO_PEERCRED Verification

**Decision**: Extract peer credentials from Unix socket connections using the socket file descriptor and `getsockopt(SOL_SOCKET, SO_PEERCRED)`.

**Rationale**: The spec mandates belt-and-suspenders security — filesystem DAC (socket mode 0600, owned by worker uid) plus kernel-verified peer credentials. SO_PEERCRED is a Linux-specific mechanism that returns the PID, UID, and GID of the connecting process.

**Alternatives considered**:
- **DAC-only (filesystem permissions)**: Simpler but loses kernel-level verification. Acceptable as a fallback.
- **`node-unix-credentials` npm package**: Provides SO_PEERCRED as a native addon. Evaluate compatibility with Node 20.
- **Raw N-API binding**: Minimal custom native code to call `getsockopt`. More control but more maintenance.
- **`net.Socket` internal fd access**: Use `socket._handle.fd` to get the file descriptor, then call getsockopt via a small native module. This is the most likely approach.

**Fallback strategy**: If native SO_PEERCRED is not available in the build environment, fall back to DAC-only protection with a warning log. The filesystem permissions are the primary security gate.

### In-Memory Credential Storage

**Decision**: Store credential values in a JavaScript `Map<string, Map<string, CredentialCacheEntry>>` keyed by session ID then credential ID. Never persist to disk.

**Rationale**: The spec explicitly states "memory-only in the credhelper." The only on-disk artifacts are rendered exposure files on tmpfs. The Map provides O(1) lookup for data socket requests and easy cleanup when a session ends.

**Pattern**:
```typescript
interface CredentialCacheEntry {
  value: Secret;
  expiresAt: Date;
  refreshTimerId?: NodeJS.Timeout;
}
```

### Background Token Refresh

**Decision**: Use `setTimeout` chains scheduled at 75% of each credential's TTL.

**Rationale**: Simpler and more precise than `setInterval`. Each credential gets its own refresh timer. When a refresh fires, it calls the plugin's `mint()` method, updates the store, and schedules the next refresh. If mint fails, the credential is marked unavailable and the timer stops (fail-closed for that credential).

**Alternatives considered**:
- **`setInterval` per credential**: Slightly simpler but less precise — the interval doesn't account for the time the mint call takes.
- **Single sweep timer**: Coarser granularity. With many credentials having different TTLs, individual timers are more correct.
- **`cron`-style scheduler**: Overkill for simple timeout scheduling.

### Session Directory Layout

**Decision**: Follow the spec exactly:
```
/run/generacy-credhelper/sessions/<id>/
├── env                       # sourceable KEY=VALUE file
├── git/
│   ├── config                # [credential] helper = !<path>/credential-helper
│   └── credential-helper     # #!/bin/sh script querying data.sock via curl
├── gcp/
│   └── external-account.json # type: external_account, credential_source.url → data.sock
└── data.sock                 # per-session HTTP server for fresh tokens
```

**Rationale**: Each exposure type has a well-defined rendering:
- **env**: Simple `KEY=VALUE\n` format. Secret value is on tmpfs (documented trade-off — mint TTL must cover full workflow).
- **git-credential-helper**: A shell script that uses `curl --unix-socket` to query the data socket. The git config file points at this script. Secrets never touch disk.
- **gcloud-external-account**: A JSON file following Google's external account format where `credential_source.url` points at `http://localhost/credential/<id>` over the Unix socket. Token is fetched on demand. Secret never on disk.

### Error Response Format

**Decision**: `{ error: string, code: string, details?: object }` with HTTP status codes (per clarification Q5).

**Codes**: `INVALID_ROLE`, `ROLE_NOT_FOUND`, `PLUGIN_NOT_FOUND`, `PLUGIN_MINT_FAILED`, `PLUGIN_RESOLVE_FAILED`, `UNSUPPORTED_EXPOSURE`, `NOT_IMPLEMENTED`, `SESSION_NOT_FOUND`, `SESSION_EXPIRED`, `CREDENTIAL_NOT_FOUND`, `CREDENTIAL_EXPIRED`, `BACKEND_UNREACHABLE`, `INTERNAL_ERROR`, `PEER_REJECTED`, `INVALID_REQUEST`.

**HTTP status mapping**: 400 (client errors), 404 (not found), 410 (expired), 501 (not implemented), 502 (upstream/plugin failure), 500 (internal).

## Implementation Patterns

### Request routing without a framework

Minimal URL-based routing for the control server:

```typescript
const routes: Record<string, Record<string, Handler>> = {
  'POST': { '/sessions': handleBeginSession },
  'DELETE': {}, // dynamic: /sessions/:id matched via regex
};

function route(req: http.IncomingMessage, res: http.ServerResponse) {
  const method = req.method ?? 'GET';
  const url = req.url ?? '/';

  // Static routes
  const handler = routes[method]?.[url];
  if (handler) return handler(req, res);

  // Dynamic routes
  const deleteMatch = url.match(/^\/sessions\/([^/]+)$/);
  if (method === 'DELETE' && deleteMatch) {
    return handleEndSession(req, res, deleteMatch[1]);
  }

  sendError(res, 404, 'NOT_FOUND', 'Route not found');
}
```

### Graceful shutdown pattern

```typescript
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down...');
  controlServer.close();         // stop accepting connections
  await sessionManager.endAll(); // clean up all sessions
  process.exit(0);
});
```

### Adapter interfaces for #460/#462

```typescript
interface ConfigLoader {
  loadRole(roleId: string): Promise<RoleConfig>;
  loadCredential(credentialId: string): Promise<CredentialEntry>;
  loadBackend(backendId: string): Promise<BackendEntry>;
}

interface PluginRegistry {
  getPlugin(credentialType: string): CredentialTypePlugin;
}
```

These narrow interfaces decouple the daemon from the specific config/plugin loading implementations, enabling mock-based testing and independent development.

## Key Sources

- **Spec**: `specs/461-credentials-architecture/spec.md`
- **Clarifications**: `specs/461-credentials-architecture/clarifications.md` (5 resolved questions)
- **Phase 1 types**: `packages/credhelper/src/types/` and `packages/credhelper/src/schemas/`
- **Architecture plan**: `tetrad-development/docs/credentials-architecture-plan.md`
- **Node.js `http` Unix socket**: `server.listen(path)` — native support, no libraries needed
- **SO_PEERCRED**: Linux `getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &cred, &len)` — returns `struct ucred { pid, uid, gid }`
- **Google external account format**: `type: external_account` with `credential_source.url` for URL-sourced credentials
- **Git credential helpers**: `credential.helper` config pointing to an executable that responds to `get` protocol
