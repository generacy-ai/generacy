# Data Model: Wire Credhelper Daemon Config Loader

## Core Interfaces

### ConfigLoader (existing — `packages/credhelper-daemon/src/types.ts:49-54`)

The interface being implemented:

```typescript
interface ConfigLoader {
  loadRole(roleId: string): Promise<RoleConfig>;
  loadCredential(credentialId: string): Promise<CredentialEntry>;
  loadBackend(backendId: string): Promise<BackendEntry>;
}
```

### ConfigResult (existing — `packages/credhelper/src/config/types.ts:20-26`)

The data source backing the adapter:

```typescript
interface ConfigResult {
  backends: BackendsConfig;        // { schemaVersion: '1', backends: BackendEntry[] }
  credentials: CredentialsConfig;  // { schemaVersion: '1', credentials: CredentialEntry[] }
  trustedPlugins: TrustedPluginsConfig | null;
  roles: Map<string, RoleConfig>;  // Keyed by role ID
  overlayIds: string[];
}
```

### LoadConfigOptions (existing — `packages/credhelper/src/config/types.ts:14-18`)

```typescript
interface LoadConfigOptions {
  agencyDir: string;
  pluginRegistry?: Map<string, ExposureKind[]>;  // Optional validation
  logger?: { info(msg: string): void };
}
```

## Data Entities

### BackendEntry
```typescript
{ id: string; type: string; endpoint?: string; auth?: { mode: string; [key: string]: unknown } }
```

### CredentialEntry
```typescript
{ id: string; type: string; backend: string; backendKey: string; mint?: { ttl: string; scopeTemplate?: Record<string, unknown> } }
```

### RoleConfig
```typescript
{ schemaVersion: '1'; id: string; description: string; extends?: string; credentials: RoleCredentialRef[]; proxy?: Record<string, ProxyConfig>; docker?: DockerConfig }
```

## Lookup Semantics

| Method | Source | Key | Lookup |
|---|---|---|---|
| `loadRole(id)` | `config.roles` | `id` | `Map.get(id)` — O(1) |
| `loadCredential(id)` | `config.credentials.credentials` | `id` | `Array.find(c => c.id === id)` — O(n) |
| `loadBackend(id)` | `config.backends.backends` | `id` | `Array.find(b => b.id === id)` — O(n) |

Note: Roles use a `Map` (from `resolveRoleExtends`), while credentials and backends are arrays. The array sizes are small (typically <20 entries), so linear scan is acceptable.

## Validation

All validation happens at startup via `loadConfig()`:
- YAML schema validation (Zod)
- Cross-reference validation (credential → backend refs, role → credential refs)
- Exposure plugin support validation (optional, if pluginRegistry provided)
- Role inheritance chain resolution

Runtime lookups only need existence checks — if an ID passes startup validation but is still not found at runtime, it indicates an internal inconsistency (hence the error codes).
