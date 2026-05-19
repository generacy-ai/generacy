# Data Model: App-Config Secrets Env Renderer

## Core Entities

### AppConfigSecretEnvStore

New store class managing the secrets env file lifecycle.

```typescript
class AppConfigSecretEnvStore {
  // State
  private status: StoreStatus;          // 'ok' | 'fallback' | 'disabled'
  private envPath: string | null;       // Resolved file path (null when disabled)
  private reason: string | undefined;   // Human-readable degradation reason
  private writeChain: Promise<void>;    // In-process serialization mutex

  // Dependencies (constructor-injected)
  private backend: ClusterLocalBackend; // Encrypted secret storage
  private fileStore: AppConfigFileStore; // Metadata (values.yaml) access

  // Lifecycle
  async init(): Promise<void>;
  async renderAll(): Promise<RenderResult>;

  // CRUD
  async set(name: string, value: string): Promise<void>;
  async delete(name: string): Promise<boolean>;

  // Status
  getStatus(): StoreStatus;
  getInitResult(): StoreInitResult;
}
```

### RenderResult

Result of boot-time full render.

```typescript
interface RenderResult {
  rendered: string[];   // Secret names successfully written
  failed: string[];     // Secret names that failed to unseal
}
```

## Existing Types (unchanged)

### StoreStatus / StoreInitResult / InitResult

From `packages/control-plane/src/types/init-result.ts`:

```typescript
type StoreStatus = 'ok' | 'fallback' | 'disabled';

interface StoreInitResult {
  status: StoreStatus;
  path?: string;
  reason?: string;
}

interface InitResult {
  stores: Record<string, StoreInitResult>;  // Gains 'appConfigSecretEnv' key
  warnings: string[];
}
```

### AppConfigValuesMetadata

From `AppConfigFileStore` — the metadata YAML structure that tracks which entries are secrets:

```typescript
interface AppConfigValuesMetadata {
  env: Record<string, AppConfigEnvMetadata>;
  files: Record<string, AppConfigFileMetadata>;
}

interface AppConfigEnvMetadata {
  secret: boolean;
  updatedAt: string;   // ISO 8601
}
```

### ClusterLocalBackend (read-only dependency)

```typescript
// Key format for app-config secrets: 'app-config/env/${name}'
interface BackendClient {
  fetchSecret(key: string): Promise<string>;  // Throws StorageError('SECRET_NOT_FOUND')
}

interface WritableBackendClient extends BackendClient {
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

## File Formats

### secrets.env

Same format as the existing plaintext env file. Docker Compose `env_file:` compatible:

```
SERVICE_ANTHROPIC_API_KEY="sk-ant-..."
TWILIO_AUTH_TOKEN="abc123def..."
```

**Escaping rules** (shared with AppConfigEnvStore):
- `\` → `\\`
- `"` → `\"`
- `\n` → `\\n`

### init-result.json (extended)

Gains a new key in the `stores` record:

```json
{
  "stores": {
    "appConfigEnv": { "status": "ok", "path": "/var/lib/generacy-app-config/env" },
    "appConfigFile": { "status": "ok", "path": "/var/lib/generacy-app-config/values.yaml" },
    "appConfigSecretEnv": { "status": "ok", "path": "/run/generacy-app-config/secrets.env" }
  },
  "warnings": [],
  "timestamp": "2026-05-16T00:00:00.000Z"
}
```

## Data Flow

### Boot-Time Render

```
ClusterLocalBackend.init()
  → AppConfigSecretEnvStore.init()  (directory + fallback)
  → AppConfigSecretEnvStore.renderAll()
    → AppConfigFileStore.getMetadata()  (read values.yaml)
    → filter entries where secret === true
    → for each: ClusterLocalBackend.fetchSecret('app-config/env/${name}')
    → writeAll(entries)  (atomic temp+rename)
```

### PUT with secret=true (new entry)

```
handlePutEnv(name, value, secret=true)
  → ClusterLocalBackend.setSecret('app-config/env/${name}', value)
  → AppConfigSecretEnvStore.set(name, value)  (atomic rewrite)
  → AppConfigFileStore.setEnvMetadata(name, true)
  → emit relay event
```

### PUT with secret-flag transition (true → false)

```
handlePutEnv(name, value, secret=false)
  → read prior metadata: secret === true (flag mismatch detected)
  → AppConfigEnvStore.set(name, value)           (write new location first)
  → ClusterLocalBackend.deleteSecret(...)         (delete old location second)
  → AppConfigSecretEnvStore.delete(name)          (remove from secrets.env)
  → AppConfigFileStore.setEnvMetadata(name, false) (update metadata last)
  → emit relay event
```

### DELETE of a secret

```
handleDeleteEnv(name)
  → read metadata: secret === true
  → ClusterLocalBackend.deleteSecret('app-config/env/${name}')
  → AppConfigSecretEnvStore.delete(name)
  → AppConfigFileStore.deleteEnvMetadata(name)
  → emit relay event
```

## Validation Rules

- `name`: non-empty string (validated by existing `PutAppConfigEnvBodySchema`)
- `value`: string (validated by existing schema)
- `secret`: boolean, defaults to `false` (validated by existing schema)
- File path: only two allowed paths (preferred + fallback); no user-controlled path input
- Key format in backend: `app-config/env/${name}` (matches existing convention)
