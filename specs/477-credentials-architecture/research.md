# Research: Wire Credhelper Daemon Config Loader

## Technology Decisions

### 1. Adapter Pattern (Static Config → Async Interface)

**Decision**: Load config once at startup, wrap in async adapter methods.

**Rationale**: The `ConfigLoader` interface is async (`Promise<T>` returns) to allow future implementations (e.g., remote config, database-backed). However, `loadConfig()` from `@generacy-ai/credhelper` is synchronous and file-based. The simplest correct approach is: load once, serve from memory.

**Alternatives considered**:
- **Lazy loading per request**: Rejected — unnecessary I/O overhead, and the spec explicitly states hot-reload is out of scope
- **Re-reading config on each call**: Rejected — YAML parsing + Zod validation on every session creation is wasteful and creates TOCTOU issues

### 2. Error Mapping

**Decision**: Use existing `CredhelperError` error codes for not-found lookups.

**Rationale**: The daemon already has well-defined error codes (`ROLE_NOT_FOUND`, `CREDENTIAL_NOT_FOUND`, `BACKEND_UNREACHABLE`) with HTTP status mappings. Creating new error classes would duplicate this infrastructure.

**Mapping**:
| Lookup failure | Error code | HTTP status |
|---|---|---|
| Role not found | `ROLE_NOT_FOUND` | 404 |
| Credential not found | `CREDENTIAL_NOT_FOUND` | 404 |
| Backend not found | `BACKEND_UNREACHABLE` | 502 |

Note: `BACKEND_UNREACHABLE` is the closest existing code for a missing backend. A backend that doesn't exist in config is effectively unreachable.

### 3. Startup Validation Strategy

**Decision**: Fail-closed with detailed error logging before daemon.start().

**Rationale**: The architecture plan mandates fail-closed behavior. A daemon that starts with invalid config would accept session requests but fail unpredictably during credential resolution. By validating at startup:
- Config errors surface immediately
- No partial startup (control socket never binds)
- Error messages include file paths and field locations from `ConfigValidationError.errors`

### 4. Agency Directory Resolution

**Decision**: `CREDHELPER_AGENCY_DIR` env var → `resolve(cwd, '.agency')` fallback.

**Rationale**: Follows the same env-var-with-sensible-default pattern used by other daemon config (`CREDHELPER_CONTROL_SOCKET`, `CREDHELPER_SESSIONS_DIR`). The `.agency/` directory is the standard location defined by the credentials architecture plan.

## Implementation Patterns

### Config Loading Pattern (from `loadConfig()`)

`loadConfig()` reads the `.agency/` directory structure:
```
.agency/
├── secrets/
│   ├── backends.yaml        # Required
│   ├── credentials.yaml     # Required
│   └── credentials.local.yaml  # Optional overlay
└── roles/
    └── *.yaml               # One file per role
```

Returns `ConfigResult`:
- `backends: BackendsConfig` — `{ schemaVersion, backends: BackendEntry[] }`
- `credentials: CredentialsConfig` — `{ schemaVersion, credentials: CredentialEntry[] }`
- `roles: Map<string, RoleConfig>` — keyed by role ID
- `trustedPlugins: TrustedPluginsConfig | null`
- `overlayIds: string[]`

### Existing Test Infrastructure

The daemon's integration tests use:
- vitest for test runner
- Temp directories via `mkdtemp`
- Direct `Daemon` class instantiation (not process spawning)
- Mock config loaders from `__tests__/mocks/mock-config-loader.ts`
- Real Unix socket communication for control server tests

For the negative test (verifying process exit on invalid config), spawning the daemon as a child process is needed since `process.exit()` can't be tested in-process.
