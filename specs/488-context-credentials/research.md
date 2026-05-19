# Research: Remove cloud-side credential storage and OIDC code

**Feature**: #488 | **Date**: 2026-04-28

## Dependency Analysis

### `jose` npm package

- **Version**: `^6.2.2`
- **Only consumer**: `src/auth/jwt-parser.ts` (imports `decodeJwt`)
- **Verdict**: Safe to remove from `package.json` dependencies when `jwt-parser.ts` is deleted
- No other package in the monorepo imports `jose`

### `JwtParser` class

- **Defined in**: `src/auth/jwt-parser.ts`
- **Consumers**:
  - `src/auth/session-token-store.ts` — constructor dependency (being deleted)
  - `bin/credhelper-daemon.ts` — runtime instantiation (needs cleanup)
  - `__tests__/auth/jwt-parser.test.ts` — direct test (being deleted)
  - `__tests__/auth/session-token-store.test.ts` — mock (being deleted)
  - `__tests__/integration/session-token-flow.test.ts` — integration test (being deleted)
  - `__tests__/integration/config-loading.test.ts` — integration test (needs cleanup)
- **Verdict**: All consumers are either being deleted or need modification. Safe to delete.

### `SessionTokenStore` class

- **Defined in**: `src/auth/session-token-store.ts`
- **Consumers**:
  - `src/control-server.ts` — constructor param + 3 route handlers (needs cleanup)
  - `src/types.ts` — `DaemonConfig` interface member (needs cleanup)
  - `src/backends/factory.ts` — constructor param for cloud backend (needs cleanup)
  - `src/daemon.ts` — `loadFromDisk()` call + wiring (needs cleanup)
  - `bin/credhelper-daemon.ts` — instantiation (needs cleanup)
  - Multiple test files — mocked or instantiated (need cleanup/deletion)
- **Verdict**: Deeply wired but all references are cleanly removable.

### `GeneracyCloudBackend` class

- **Defined in**: `src/backends/generacy-cloud-backend.ts`
- **Consumers**:
  - `src/backends/factory.ts` — `'generacy-cloud'` switch case (needs cleanup)
  - `__tests__/backends/generacy-cloud-backend.test.ts` — direct test (being deleted)
- **Verdict**: Minimal surface area. Clean deletion.

## Impact on Other Files

### `src/backends/index.ts` (barrel export)

Currently exports:
```typescript
export { DefaultBackendClientFactory } from './factory.js';
export type { BackendClientFactory } from './types.js';
```

Does NOT export `GeneracyCloudBackend` — no change needed.

### `src/auth/` directory

No `index.ts` barrel export exists. After deleting both files, the `auth/` directory will be empty. Git doesn't track empty directories, so it will disappear from the repo automatically.

## Patterns

### Backend Factory Pattern

The `DefaultBackendClientFactory` uses a switch statement on `BackendEntry.type`:
- `'env'` → `EnvBackend` (keep)
- `'generacy-cloud'` → `GeneracyCloudBackend` (remove)
- `default` → throws error with supported types list

After removal, only `'env'` remains active. The error message should reference `'env'` and `'cluster-local'` (forthcoming in phase 2) to guide users toward the correct configuration.

### Control Server Route Pattern

Routes are registered inline in the `ControlServer.start()` method via URL path matching on the `IncomingMessage`. The three auth routes are self-contained blocks that can be cleanly removed without affecting the session management routes.

## Alternatives Considered

| Option | Decision | Rationale |
|--------|----------|-----------|
| Stub out `generacy-cloud` backend instead of deleting | Rejected | No users depend on it; clean deletion preferred |
| Keep `jose` dependency for future use | Rejected | Easy to re-add; dead dependencies add confusion |
| Keep `jwt-parser.ts` for potential future use | Rejected | Trivial to recreate; dead code violates codebase hygiene |
| Remove `SessionTokenProvider` interface from types | Evaluate | Only remove if no other code references it |
