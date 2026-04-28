# Data Model: Cluster-Local Credhelper Backend

**Feature**: #491 | **Date**: 2026-04-28

## Core Entities

### WritableBackendClient (Interface)

Extends the existing read-only `BackendClient` with write operations.

```typescript
// packages/credhelper/src/types/context.ts

export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

export interface WritableBackendClient extends BackendClient {
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

**Notes**:
- `BackendClient` remains unchanged (read-only); existing backends (`EnvBackend`) are unaffected
- `WritableBackendClient` is the capability interface for backends that support mutation
- Control-plane routes type-narrow to `WritableBackendClient` at call sites

### EncryptedEntry

Represents a single encrypted credential stored on disk.

```typescript
// packages/credhelper-daemon/src/backends/crypto.ts

export interface EncryptedEntry {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte IV */
  iv: string;
  /** Base64-encoded 16-byte GCM auth tag */
  authTag: string;
}
```

### CredentialFileEnvelope

The on-disk JSON file format.

```typescript
// packages/credhelper-daemon/src/backends/file-store.ts

export interface CredentialFileEnvelope {
  /** File format version (currently 1) */
  version: number;
  /** Map of credential key to encrypted entry */
  entries: Record<string, EncryptedEntry>;
}
```

**Zod Schema**:

```typescript
const EncryptedEntrySchema = z.object({
  ciphertext: z.string(),
  iv: z.string(),
  authTag: z.string(),
});

const CredentialFileEnvelopeSchema = z.object({
  version: z.number().int().positive(),
  entries: z.record(z.string(), EncryptedEntrySchema),
});
```

### ClusterLocalBackend

The backend implementation.

```typescript
// packages/credhelper-daemon/src/backends/cluster-local-backend.ts

export class ClusterLocalBackend implements WritableBackendClient {
  private masterKey: Buffer;
  private cache: Map<string, EncryptedEntry>;
  private fileStore: CredentialFileStore;

  constructor(options: ClusterLocalBackendOptions);

  /** Initialize: load master key and credential file */
  init(): Promise<void>;

  /** Decrypt and return a credential value */
  fetchSecret(key: string): Promise<string>;

  /** Encrypt and store a credential value */
  setSecret(key: string, value: string): Promise<void>;

  /** Remove a credential */
  deleteSecret(key: string): Promise<void>;
}

export interface ClusterLocalBackendOptions {
  /** Path to credentials data file (default: /var/lib/generacy/credentials.dat) */
  dataPath?: string;
  /** Path to master key file (default: /var/lib/generacy/master.key) */
  keyPath?: string;
}
```

### CredentialFileStore

Handles file I/O with atomic writes and advisory locking.

```typescript
// packages/credhelper-daemon/src/backends/file-store.ts

export class CredentialFileStore {
  constructor(dataPath: string, keyPath: string);

  /** Create master key if absent; return the key buffer */
  ensureMasterKey(): Promise<Buffer>;

  /** Read and parse the credential file; returns empty map if file doesn't exist */
  load(): Promise<Map<string, EncryptedEntry>>;

  /** Atomically write entries to the credential file (under advisory lock) */
  save(entries: Map<string, EncryptedEntry>): Promise<void>;
}
```

## Relationships

```
BackendClient (read-only)
    ^
    |  extends
    |
WritableBackendClient (read + write)
    ^
    |  implements
    |
ClusterLocalBackend
    |
    |  uses
    v
CredentialFileStore ──> CredentialFileEnvelope (on-disk JSON)
    |                          |
    |  uses                    |  contains
    v                          v
crypto.ts helpers       EncryptedEntry (per-credential)
    |
    |  uses
    v
Master Key (32-byte AES-256 key file)
```

## Validation Rules

| Field | Rule |
|-------|------|
| `CredentialFileEnvelope.version` | Must be `1` (current); unknown values → `CREDENTIAL_STORE_MIGRATION_NEEDED` |
| `EncryptedEntry.iv` | Valid base64, decodes to 12 bytes |
| `EncryptedEntry.authTag` | Valid base64, decodes to 16 bytes |
| `EncryptedEntry.ciphertext` | Valid base64, non-empty |
| Master key file | Exactly 32 bytes; mode 0600 |
| Credential key (map key) | Non-empty string |
| Credential value (plaintext) | Non-empty string; never logged |

## File Layout on Disk

```
/var/lib/generacy/                    # Persistent named volume
├── master.key                        # 32 raw bytes, mode 0600, uid 1002
└── credentials.dat                   # JSON envelope, mode 0600
    └── (temp) credentials.dat.tmp.{pid}  # Atomic write staging
```

## Error States

| Condition | Error Code | Behavior |
|-----------|-----------|----------|
| `credentials.dat` missing | (none) | Initialize empty store |
| `credentials.dat` invalid JSON | `CREDENTIAL_STORE_CORRUPT` | Fail closed, refuse to start |
| `credentials.dat` unknown version | `CREDENTIAL_STORE_MIGRATION_NEEDED` | Fail closed, distinct error |
| `master.key` missing on init | (none) | Generate new 32-byte key |
| `master.key` unreadable | `BACKEND_UNREACHABLE` | Fail closed |
| Key not in store | `BACKEND_SECRET_NOT_FOUND` | Standard backend error |
| Auth tag mismatch (tampered) | `CREDENTIAL_STORE_CORRUPT` | Fail closed |
