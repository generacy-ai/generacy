# Feature Specification: Wire Credhelper Daemon Config Loader (Phase 6)

**Branch**: `477-credentials-architecture` | **Date**: 2026-04-15 | **Status**: Draft

## Summary

Fix an integration gap between #461 (credhelper daemon) and #462 (config loader). Both components shipped independently but the daemon's config loader hook remains stubbed with `throw new Error(...)` calls, making the daemon unable to start. This issue wires the real `loadConfig()` from `@generacy-ai/credhelper` into the daemon binary, unblocking end-to-end testing of the credentials architecture.

**Context:** Part of the [credentials architecture plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md).

**Blocks:** End-to-end testing of the credentials architecture.

**Related:** #461 (daemon), #462 (config loader)

## Problem

`packages/credhelper-daemon/bin/credhelper-daemon.ts:31-47` contains three stub errors left over from when #461 was implemented before #462:

```typescript
// Current (broken):
const configLoader = {
  loadBackends: () => { throw new Error('Config loader not yet integrated (#462)'); },
  loadCredential: () => { throw new Error('Config loader not yet integrated (#462)'); },
  loadRole: () => { throw new Error('Config loader not yet integrated (#462)'); },
};
```

The real config loader was implemented in #462 at `packages/credhelper/src/config/loader.ts` — specifically `loadConfig()` which reads and validates the full `.agency/` directory. It was never wired into the daemon binary.

Result: **the daemon cannot start.** Any call to `loadBackends`, `loadCredential`, or `loadRole` throws. The session manager depends on all three.

## What needs to be done

### 1. Wire the real config loader in `credhelper-daemon.ts`

Replace the stub object at `bin/credhelper-daemon.ts:31-47` with a real adapter over `loadConfig()` from `@generacy-ai/credhelper`:

```typescript
import { loadConfig } from '@generacy-ai/credhelper';

// Load config once at startup
const agencyDir = process.env.CREDHELPER_AGENCY_DIR ?? resolve(process.cwd(), '.agency');
const config = await loadConfig({ agencyDir });

// Build the ConfigLoader interface that SessionManager consumes
const configLoader: ConfigLoader = {
  loadBackends: () => config.backends,
  loadCredential: (id: string) => {
    const credential = config.credentials.find(c => c.id === id);
    if (!credential) throw new CredentialNotFoundError(id);
    return credential;
  },
  loadRole: (id: string) => {
    const role = config.roles.find(r => r.id === id);
    if (!role) throw new RoleNotFoundError(id);
    return role;
  },
};
```

### 2. Startup failure handling

If `loadConfig()` throws (invalid YAML, missing refs, unsupported exposures, etc.), log the full error with file paths and field locations, then exit non-zero. The daemon must fail closed per the architecture plan — a running daemon with invalid config would be dangerous.

### 3. Env var for agency directory

Default `CREDHELPER_AGENCY_DIR` to `${PWD}/.agency` for developer convenience. Allow override via env var for custom layouts (monorepo roots, test fixtures, etc.).

### 4. Integration test

Add an integration test at `packages/credhelper-daemon/tests/integration/config-loading.test.ts` that:
1. Creates a temp dir with a minimal valid `.agency/` structure (one backend, one credential, one role)
2. Starts the daemon pointing at the temp dir
3. Verifies it reaches "ready" state (control socket bound, accepting connections)
4. Makes a `POST /sessions` call and verifies the role is resolved correctly
5. Tears down

Also add a negative test: daemon started against an invalid config (e.g. role references a nonexistent credential) should exit non-zero with the validation error logged.

## User Stories

### US1: Daemon Startup with Valid Config

**As a** platform operator,
**I want** the credhelper daemon to start successfully by loading configuration from the `.agency/` directory,
**So that** credential sessions can be created for agent processes.

**Acceptance Criteria**:
- [ ] Daemon starts without errors when pointed at a valid `.agency/` directory
- [ ] `loadBackends`, `loadCredential`, and `loadRole` resolve from real config
- [ ] `POST /sessions` correctly resolves roles and credentials from loaded config

### US2: Fail-Closed on Invalid Config

**As a** platform operator,
**I want** the daemon to exit immediately with a clear error when config is invalid,
**So that** a misconfigured daemon never runs and silently fails credential operations.

**Acceptance Criteria**:
- [ ] Daemon exits non-zero on invalid YAML, missing refs, or unsupported exposures
- [ ] Error message includes file paths and field locations for quick diagnosis
- [ ] No partial startup — daemon never binds the control socket with bad config

### US3: Configurable Agency Directory

**As a** developer,
**I want** to override the agency directory path via `CREDHELPER_AGENCY_DIR`,
**So that** I can run the daemon against test fixtures or non-standard project layouts.

**Acceptance Criteria**:
- [ ] Defaults to `${PWD}/.agency` when env var is not set
- [ ] Respects `CREDHELPER_AGENCY_DIR` when set

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace three stub `throw` calls with real `loadConfig()` adapter | P1 | Core fix |
| FR-002 | Wrap `loadConfig()` in try/catch; log full error and `process.exit(1)` on failure | P1 | Fail-closed safety |
| FR-003 | Read `CREDHELPER_AGENCY_DIR` env var, default to `resolve(cwd, '.agency')` | P1 | Developer convenience |
| FR-004 | `CredentialNotFoundError` / `RoleNotFoundError` thrown for unknown IDs | P2 | Runtime safety |
| FR-005 | Integration test: valid config → daemon ready → session creation works | P1 | Verification |
| FR-006 | Integration test: invalid config → daemon exits non-zero with error logged | P1 | Negative case |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Stub throws removed | 0 remaining | `grep 'not yet integrated' packages/` returns no matches |
| SC-002 | Daemon startup | Successful against valid `.agency/` | Integration test passes |
| SC-003 | Fail-closed behavior | Exit code ≠ 0 on invalid config | Negative integration test passes |
| SC-004 | All tests pass | 100% pass rate | CI green |

## Assumptions

- `loadConfig()` from #462 is already implemented and exported from `@generacy-ai/credhelper`
- The `ConfigLoader` interface consumed by `SessionManager` matches the three-method shape (`loadBackends`, `loadCredential`, `loadRole`)
- The `.agency/` directory structure (backends, credentials, roles YAML files) is stable from #462

## Out of Scope

- Hot-reloading config changes (config is loaded once at daemon startup)
- Config file watching or automatic restart on change
- Changes to the `loadConfig()` implementation in `@generacy-ai/credhelper`
- Changes to the session manager or control socket API
- Plugin loader modifications

---

*Generated by speckit*
