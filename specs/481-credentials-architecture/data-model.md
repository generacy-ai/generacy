# Data Model: BackendClient Factory (Phase 7a)

## Core Entities

### BackendClientFactory (new)

```typescript
// packages/credhelper-daemon/src/backends/types.ts
import type { BackendClient, BackendEntry } from '@generacy-ai/credhelper';

export interface BackendClientFactory {
  create(backend: BackendEntry): BackendClient;
}
```

Takes a `BackendEntry` config (from `backends.yaml` via `ConfigLoader`) and returns a working `BackendClient` implementation. Dispatch is by `backend.type`.

### EnvBackend (new)

```typescript
// packages/credhelper-daemon/src/backends/env-backend.ts
import type { BackendClient } from '@generacy-ai/credhelper';

export class EnvBackend implements BackendClient {
  async fetchSecret(key: string): Promise<string>;
}
```

Reads `process.env[key]`. Throws `BACKEND_SECRET_NOT_FOUND` if `undefined`. Returns empty string if value is `''` (intentional).

### GeneracyCloudBackend (new — stub)

```typescript
// packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts
import type { BackendClient } from '@generacy-ai/credhelper';

export class GeneracyCloudBackend implements BackendClient {
  async fetchSecret(_key: string): Promise<string>;
  // Always throws NOT_IMPLEMENTED
}
```

Placeholder until Phase 7b. Gives clear error with guidance.

## Existing Entities (unchanged)

### BackendClient (shared package)

```typescript
// packages/credhelper/src/types/context.ts
export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}
```

Single-method interface. Used by `MintContext.backend` and `ResolveContext.backend`.

### BackendEntry (shared package)

```typescript
// packages/credhelper/src/schemas/backends.ts
export interface BackendEntry {
  id: string;           // e.g., "env-local"
  type: string;         // e.g., "env", "generacy-cloud"
  endpoint?: string;    // URL — unused by env backend
  auth?: BackendAuth;   // Auth config — unused by env backend
}
```

### MintContext / ResolveContext (shared package)

```typescript
export interface MintContext {
  credentialId: string;
  backendKey: string;         // e.g., "GITHUB_APP_PRIVATE_KEY"
  backend: BackendClient;     // ← was stub, now real
  scope: Record<string, unknown>;
  ttl: number;
  config: Record<string, unknown>;
}

export interface ResolveContext {
  credentialId: string;
  backendKey: string;
  backend: BackendClient;     // ← was stub, now real
  config: Record<string, unknown>;
}
```

## Modified Entities

### DaemonConfig

```typescript
// packages/credhelper-daemon/src/types.ts — add field
export interface DaemonConfig {
  // ... existing fields ...
  backendFactory: BackendClientFactory;  // NEW
}
```

### ErrorCode

```typescript
// packages/credhelper-daemon/src/errors.ts — add variant
export type ErrorCode =
  | // ... existing codes ...
  | 'BACKEND_SECRET_NOT_FOUND';  // NEW — HTTP 502

// HTTP_STATUS_MAP addition:
BACKEND_SECRET_NOT_FOUND: 502,
```

## Relationships

```
backends.yaml
  └── BackendEntry (config)
        └── BackendClientFactory.create()
              ├── type: "env" → EnvBackend
              └── type: "generacy-cloud" → GeneracyCloudBackend (stub)
                    └── BackendClient
                          ├── MintContext.backend (used by plugin.mint())
                          └── ResolveContext.backend (used by plugin.resolve())
```

## Validation Rules

| Rule | Location | Behavior |
|------|----------|----------|
| Unknown backend type | `BackendClientFactory.create()` | Throws `BACKEND_UNREACHABLE` with supported types list |
| Missing env var | `EnvBackend.fetchSecret()` | Throws `BACKEND_SECRET_NOT_FOUND` (key named in error) |
| Empty string env var | `EnvBackend.fetchSecret()` | Returns `''` (valid — user may intentionally set empty) |
| generacy-cloud used | `GeneracyCloudBackend.fetchSecret()` | Throws `NOT_IMPLEMENTED` with Phase 7b guidance |
| Secret values in logs | All backends | Never logged — only key names |
