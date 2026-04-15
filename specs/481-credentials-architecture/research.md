# Research: BackendClient Factory (Phase 7a)

## Technology Decisions

### 1. Simple switch-based factory vs. plugin registry

**Decision**: Simple switch in `BackendClientFactory.create()`.

**Rationale**: Only two backend types exist (`env`, `generacy-cloud`). A full plugin registry (with dynamic loading, registration, schema validation) is overkill until there's demand for community backend plugins. The switch is ~15 lines of code and trivially extensible.

**Alternative considered**: `Map<string, () => BackendClient>` registry pattern — rejected because it adds indirection without value for 2 types.

### 2. Stateless vs. stateful backend instances

**Decision**: Stateless — `EnvBackend` has no constructor args, no connection pool, no cache.

**Rationale**: The `env` backend reads `process.env` on every call. No state to manage. The `generacy-cloud` backend (Phase 7b) will likely be stateful (token cache, HTTP client), but the factory interface already supports this — `create()` receives the full `BackendEntry` config.

### 3. Validation at factory dispatch vs. Zod schema

**Decision**: Factory dispatch time only (per clarification Q1).

**Rationale**: Tightening `BackendEntrySchema.type` from `z.string()` to `z.enum(...)` requires a change to the shared `@generacy-ai/credhelper` package, which is out of scope. Factory dispatch gives the same fail-closed behavior: unknown types throw a clear error at session-begin time. The error message names the invalid value and lists supported types.

### 4. Error type for missing env vars

**Decision**: New error code `BACKEND_SECRET_NOT_FOUND` (HTTP 502).

**Rationale**: Distinct from `BACKEND_UNREACHABLE` (backend service down) — this means the backend is reachable but the requested key doesn't exist. HTTP 502 is appropriate: the daemon is a gateway to the backend, and the backend can't fulfill the request.

### 5. Constructor DI vs. method parameter for factory

**Decision**: Constructor injection on `SessionManager`.

**Rationale**: Consistent with existing patterns — `configLoader` and `pluginRegistry` are both constructor-injected. The factory is a stable dependency, not a per-request parameter.

### 6. Factory creates per-call vs. shared instances

**Decision**: Factory creates a new instance per call (stateless, so equivalent to singleton for `EnvBackend`).

**Rationale**: Simplest implementation. If `generacy-cloud` needs connection pooling later, the factory can cache instances by backend ID internally — no interface change needed.

## Implementation Patterns

### Backend module barrel export

```
src/backends/
├── types.ts      # BackendClientFactory interface
├── factory.ts    # Concrete factory implementation
├── env-backend.ts
├── generacy-cloud-backend.ts
└── index.ts      # Re-export factory + types
```

The barrel export keeps the import surface clean for `session-manager.ts` and `daemon.ts`.

### Error propagation pattern

Backend errors propagate through the existing plugin error wrapping in `session-manager.ts`:

```
EnvBackend.fetchSecret() throws BACKEND_SECRET_NOT_FOUND
  → plugin.mint() re-throws (plugins don't catch backend errors)
    → SessionManager catches → wraps as PLUGIN_MINT_FAILED with details
      → ControlServer → HTTP 502 response
```

The original `BACKEND_SECRET_NOT_FOUND` error details (key name, backend type) are preserved in the `PLUGIN_MINT_FAILED` wrapper via the error message chain.

### Test isolation for process.env

Integration tests that modify `process.env` must:
1. Save original value in `beforeEach`
2. Restore (or delete) in `afterEach`
3. Use unique key names (e.g., `CREDHELPER_TEST_SECRET_${testId}`) to avoid collisions with parallel test suites
