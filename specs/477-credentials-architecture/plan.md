# Implementation Plan: Wire Credhelper Daemon Config Loader (Phase 6)

**Feature**: Replace stub config loader in credhelper daemon with real `loadConfig()` from `@generacy-ai/credhelper`
**Branch**: `477-credentials-architecture`
**Status**: Complete

## Summary

Wire the real `loadConfig()` function from `@generacy-ai/credhelper` (#462) into the credhelper daemon binary (`packages/credhelper-daemon/bin/credhelper-daemon.ts`), replacing three stub `throw new Error(...)` calls that currently prevent the daemon from functioning. The implementation adapts the static `ConfigResult` returned by `loadConfig()` into the async `ConfigLoader` interface consumed by `SessionManager`, adds fail-closed startup behavior, and provides an integration test covering both happy and error paths.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Package manager**: pnpm workspaces
- **Build**: Turbo
- **Testing**: vitest
- **Key packages**: `@generacy-ai/credhelper` (config loader, types, schemas), `@generacy-ai/credhelper-daemon` (runtime daemon)
- **Dependencies**: `yaml`, `zod` (schema validation — already present)
- **No new dependencies required**

## Project Structure

### Files Modified

```
packages/credhelper-daemon/
├── bin/
│   └── credhelper-daemon.ts        # MODIFY — Replace stub configLoader with real loadConfig() adapter
└── __tests__/
    └── integration/
        └── config-loading.test.ts  # NEW — Integration test for config loading
```

### Existing Files (read-only context)

```
packages/credhelper/src/
├── config/
│   ├── loader.ts                   # loadConfig() — the function being wired in
│   ├── types.ts                    # ConfigResult, LoadConfigOptions, ConfigError
│   └── errors.ts                   # ConfigValidationError
├── schemas/
│   ├── backends.ts                 # BackendsConfig, BackendEntry
│   ├── credentials.ts              # CredentialsConfig, CredentialEntry
│   └── roles.ts                    # RoleConfig
└── index.ts                        # Exports loadConfig

packages/credhelper-daemon/src/
├── types.ts                        # ConfigLoader interface (3 async methods)
├── errors.ts                       # CredhelperError with ROLE_NOT_FOUND, CREDENTIAL_NOT_FOUND codes
├── session-manager.ts              # Consumer of ConfigLoader
└── daemon.ts                       # Passes configLoader to SessionManager
```

## Architecture

### Config Adapter Design

The core design bridges two different interfaces:

1. **`loadConfig()`** returns a static `ConfigResult` — all config loaded at once (backends, credentials, roles as `Map<string, RoleConfig>`)
2. **`ConfigLoader`** interface expects three async lookup methods: `loadRole(id)`, `loadCredential(id)`, `loadBackend(id)`

The adapter loads config once at startup, then implements per-ID lookups against the in-memory result. This is a deliberate choice (spec: "config is loaded once at daemon startup", hot-reload is out of scope).

```typescript
// Adapter shape:
const config = loadConfig({ agencyDir });

const configLoader: ConfigLoader = {
  async loadRole(roleId) {
    const role = config.roles.get(roleId);
    if (!role) throw new CredhelperError('ROLE_NOT_FOUND', `Role not found: ${roleId}`);
    return role;
  },
  async loadCredential(credentialId) {
    const cred = config.credentials.credentials.find(c => c.id === credentialId);
    if (!cred) throw new CredhelperError('CREDENTIAL_NOT_FOUND', `Credential not found: ${credentialId}`);
    return cred;
  },
  async loadBackend(backendId) {
    const backend = config.backends.backends.find(b => b.id === backendId);
    if (!backend) throw new CredhelperError('BACKEND_UNREACHABLE', `Backend not found: ${backendId}`);
    return backend;
  },
};
```

### Key Design Decisions

1. **Uses existing `CredhelperError` codes** — No new error classes. `ROLE_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, and `BACKEND_UNREACHABLE` already exist and map to proper HTTP status codes.

2. **`loadConfig()` is synchronous** — It reads files synchronously via `readFileSync`. The adapter methods are `async` to satisfy the `ConfigLoader` interface (allowing future async implementations), but the initial load happens synchronously before `daemon.start()`.

3. **Fail-closed on startup** — If `loadConfig()` throws `ConfigValidationError`, the daemon logs all errors with file paths and field locations, then calls `process.exit(1)`. The existing `daemon.start().catch(...)` handler at line 76-79 already exits on fatal errors, but config loading happens before `daemon.start()` so it needs its own try/catch.

4. **`CREDHELPER_AGENCY_DIR` env var** — Defaults to `resolve(process.cwd(), '.agency')`. Uses `node:path.resolve()` for absolute path resolution.

### Startup Flow (Modified)

```
1. Parse env vars (existing: socket path, sessions dir, UIDs)
2. NEW: Resolve agencyDir from CREDHELPER_AGENCY_DIR or default
3. NEW: Call loadConfig({ agencyDir }) — fail-closed on error
4. Build plugin registry (existing)
5. NEW: Build ConfigLoader adapter from ConfigResult
6. Construct DaemonConfig with real configLoader
7. Create Daemon, install signal handlers, start (existing)
```

### Error Logging Format

On `ConfigValidationError`, log each error with file path and field location:

```
[credhelper] Config validation failed:
  - backends.yaml: field 'backends[0].endpoint' — Invalid URL
  - roles/ci-runner.yaml: field 'credentials[0].ref' — Credential 'nonexistent' not found
```

### Integration Test Design

Test file: `packages/credhelper-daemon/__tests__/integration/config-loading.test.ts`

**Happy path test:**
1. Create temp dir with minimal `.agency/` structure:
   - `secrets/backends.yaml` — one backend entry
   - `secrets/credentials.yaml` — one credential referencing the backend
   - `roles/test-role.yaml` — one role referencing the credential
2. Start daemon with `CREDHELPER_AGENCY_DIR` pointing at temp dir
3. Verify daemon reaches ready state (control socket bound)
4. `POST /sessions` with the test role → verify 200 response
5. Tear down

**Negative test:**
1. Create temp dir with invalid `.agency/` structure (role references nonexistent credential)
2. Start daemon process pointing at temp dir
3. Verify process exits with non-zero code
4. Verify stderr contains the validation error with file path

**Test patterns follow existing integration tests:**
- `__tests__/integration/session-lifecycle.test.ts` — daemon lifecycle pattern
- `__tests__/integration/core-plugins.test.ts` — fixture setup pattern
