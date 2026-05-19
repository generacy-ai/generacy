# Implementation Plan: BackendClient Factory (Phase 7a)

**Feature**: Replace stubbed BackendClient instantiations with a real factory + env backend implementation
**Branch**: `481-credentials-architecture`
**Status**: Complete

## Summary

The credhelper daemon has four stubbed `BackendClient` instantiations in `session-manager.ts` that return empty strings for every `fetchSecret()` call, making the entire credential resolution pipeline non-functional. This plan introduces a `BackendClientFactory` with a working `env` backend (reads `process.env`), a stubbed `generacy-cloud` backend (throws `NotImplementedError`), and wires the factory into `SessionManager` via constructor DI — unblocking all credential types end-to-end.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Package**: `packages/credhelper-daemon` (runtime daemon)
- **Shared types**: `packages/credhelper` (types-only, Zod schemas — **read-only for this issue**)
- **Test framework**: Vitest
- **Existing patterns**: Constructor DI, `CredhelperError` with typed error codes, inline config adapter in `bin/credhelper-daemon.ts`

## Project Structure

### New Files

```
packages/credhelper-daemon/
├── src/backends/
│   ├── types.ts                     # BackendClientFactory interface
│   ├── factory.ts                   # Concrete factory (switch on type)
│   ├── env-backend.ts               # EnvBackend implements BackendClient
│   └── generacy-cloud-backend.ts    # Stub — throws NotImplementedError
├── __tests__/
│   ├── backends/
│   │   ├── env-backend.test.ts
│   │   ├── generacy-cloud-backend.test.ts
│   │   └── factory.test.ts
│   └── integration/
│       └── env-backend-session.test.ts   # End-to-end with real EnvBackend
```

### Modified Files

```
packages/credhelper-daemon/
├── src/
│   ├── session-manager.ts           # Accept factory via constructor, replace 4 stubs
│   ├── types.ts                     # Add BackendClientFactory to DaemonConfig
│   ├── daemon.ts                    # Pass factory through to SessionManager
│   └── errors.ts                    # Add BACKEND_SECRET_NOT_FOUND error code
├── bin/
│   └── credhelper-daemon.ts         # Instantiate factory, pass to DaemonConfig
├── __tests__/
│   ├── session-manager.test.ts      # Update to inject mock factory
│   ├── mocks/
│   │   └── mock-config-loader.ts    # Add mock factory helper
│   └── integration/
│       └── session-lifecycle.test.ts # Update to inject factory
```

## Implementation Steps

### Step 1: Add error code for missing secrets

**File**: `packages/credhelper-daemon/src/errors.ts`

Add `'BACKEND_SECRET_NOT_FOUND'` to the `ErrorCode` union and map it to HTTP 502 in `HTTP_STATUS_MAP`. This provides a distinct, searchable error code when a backend key is missing (vs. `BACKEND_UNREACHABLE` which means the backend itself is down).

### Step 2: Create backend types

**File**: `packages/credhelper-daemon/src/backends/types.ts`

Define the `BackendClientFactory` interface:
```typescript
import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';

export interface BackendClientFactory {
  create(backend: BackendEntry): BackendClient;
}
```

This is a simple factory: takes a `BackendEntry` config object (already loaded by `ConfigLoader.loadBackend()`), returns a `BackendClient` implementation. No async creation needed — backends are stateless.

### Step 3: Implement EnvBackend

**File**: `packages/credhelper-daemon/src/backends/env-backend.ts`

```typescript
import type { BackendClient } from '@generacy-ai/credhelper';
import { CredhelperError } from '../errors.js';

export class EnvBackend implements BackendClient {
  async fetchSecret(key: string): Promise<string> {
    const value = process.env[key];
    if (value === undefined) {
      throw new CredhelperError(
        'BACKEND_SECRET_NOT_FOUND',
        `Environment variable '${key}' is not set`,
        { backendType: 'env', key },
      );
    }
    return value;
  }
}
```

Key design decisions:
- **Fail closed**: `undefined` throws; empty string `''` is returned (user may intentionally set empty).
- **Error includes key name** for debugging but never the value.
- **Stateless**: no constructor args needed. The `BackendEntry` config is not used at runtime — the `env` backend just reads `process.env`.

### Step 4: Implement GeneracyCloudBackend stub

**File**: `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts`

Throws `CredhelperError('NOT_IMPLEMENTED', ...)` on every `fetchSecret()` call. This gives users a clear error with guidance to use `backend: env` until Phase 7b lands.

### Step 5: Implement BackendClientFactory

**File**: `packages/credhelper-daemon/src/backends/factory.ts`

Simple switch dispatch on `backend.type`:
- `'env'` → `new EnvBackend()`
- `'generacy-cloud'` → `new GeneracyCloudBackend()`
- default → `throw CredhelperError('BACKEND_UNREACHABLE', ...)` naming the invalid type and listing supported types

Per clarification Q1: validation happens at factory dispatch time, not Zod schema level. The factory will be called at session-begin time when the backend is first needed.

### Step 6: Wire factory into SessionManager

**File**: `packages/credhelper-daemon/src/session-manager.ts`

1. Add `backendFactory: BackendClientFactory` as a constructor parameter (after `configLoader`)
2. Replace all 4 stubs at lines 91, 115, 132, 146:

```typescript
// Before (4 locations):
backend: { fetchSecret: async () => '' },

// After (each location):
backend: this.backendFactory.create(backend),
```

The `backend` variable (a `BackendEntry`) is already loaded at line 85 via `this.configLoader.loadBackend(credEntry.backend)`. The factory converts it to a `BackendClient`.

For the resolve path (line 146), `loadBackend()` needs to be called before the resolve block — currently it's only called inside the mint branch. Move the `loadBackend()` call above the mint/resolve branch so both paths have access.

### Step 7: Update DaemonConfig and Daemon

**File**: `packages/credhelper-daemon/src/types.ts`
- Import `BackendClientFactory` and add it to `DaemonConfig`

**File**: `packages/credhelper-daemon/src/daemon.ts`
- Pass `this.config.backendFactory` to `SessionManager` constructor

**File**: `packages/credhelper-daemon/bin/credhelper-daemon.ts`
- Import and instantiate `BackendClientFactory` from `../src/backends/factory.js`
- Add `backendFactory: new BackendClientFactoryImpl()` to the `DaemonConfig` object

### Step 8: Unit tests

**File**: `packages/credhelper-daemon/__tests__/backends/env-backend.test.ts`
- Key exists → returns value
- Key missing (undefined) → throws `BACKEND_SECRET_NOT_FOUND`
- Key set to empty string → returns `''` (valid)
- Key with whitespace value → returns as-is

**File**: `packages/credhelper-daemon/__tests__/backends/generacy-cloud-backend.test.ts`
- Any key → throws `NOT_IMPLEMENTED` with clear message

**File**: `packages/credhelper-daemon/__tests__/backends/factory.test.ts`
- `type: 'env'` → returns EnvBackend instance
- `type: 'generacy-cloud'` → returns GeneracyCloudBackend instance
- `type: 'unknown'` → throws `BACKEND_UNREACHABLE` with supported-types list

### Step 9: Update existing tests

**File**: `packages/credhelper-daemon/__tests__/session-manager.test.ts`
- Update `SessionManager` constructor calls to inject a mock `BackendClientFactory`

**File**: `packages/credhelper-daemon/__tests__/mocks/mock-config-loader.ts`
- Add `createMockBackendFactory()` helper

**File**: `packages/credhelper-daemon/__tests__/integration/session-lifecycle.test.ts`
- Update to inject mock factory

### Step 10: End-to-end integration test

**File**: `packages/credhelper-daemon/__tests__/integration/env-backend-session.test.ts`

Full session lifecycle with **real** `BackendClientFactory` + **real** `EnvBackend`:
1. Set `process.env.TEST_SECRET = 'my-secret-value'`
2. Configure mock role → credential → backend (`type: env`, `backendKey: TEST_SECRET`)
3. Create SessionManager with real factory (not mocked)
4. POST /sessions → begin session
5. Verify env file contains `TEST_SECRET=my-secret-value`
6. Verify data socket returns the credential
7. Clean up `process.env.TEST_SECRET`

This is the key acceptance test — it proves the factory + env backend + session rendering chain works end-to-end.

## Dependency Graph

```
Step 1 (error code) ──┐
                       ├── Step 3 (EnvBackend) ──┐
Step 2 (types) ────────┤                          │
                       ├── Step 4 (cloud stub) ───┼── Step 5 (factory) ── Step 6 (wire SM) ── Step 7 (daemon) ── Step 8-10 (tests)
                       └──────────────────────────┘
```

Steps 1-4 can be done in parallel. Steps 5-7 are sequential. Tests (8-10) can be done in parallel after step 7.

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Breaking existing tests (mock expectations change) | Step 9 explicitly addresses this; mock factory returns same stubs as before |
| `loadBackend()` not called in resolve path | Step 6 moves the call above the branch |
| BackendEntry shape mismatch | Factory only uses `type` field; other fields are for future backends |
| env var race conditions in tests | Each integration test sets/cleans its own env vars in beforeEach/afterEach |

## Out of Scope (per spec + clarifications)

- Changes to `@generacy-ai/credhelper` shared types package (Zod schema stays `z.string()`)
- Per-plugin integration tests (deferred per clarification Q2)
- `generacy-cloud` backend implementation (Phase 7b)
- Plugin loader / community backend plugin system
