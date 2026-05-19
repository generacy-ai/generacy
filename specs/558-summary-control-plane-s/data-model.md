# Data Model — #558 Credential Persistence in Control-Plane

## Core Entities

### Encrypted Credential Store

```typescript
/** AES-256-GCM encrypted entry for a single credential */
interface EncryptedEntry {
  /** Base64-encoded ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector (random per entry) */
  iv: string;
  /** Base64-encoded 16-byte authentication tag */
  authTag: string;
}

/** On-disk JSON envelope at /var/lib/generacy/credentials.dat */
interface CredentialFileEnvelope {
  /** Schema version for forward compatibility (currently 1) */
  version: number;
  /** Map of credentialId → encrypted entry */
  entries: Record<string, EncryptedEntry>;
}
```

### Credential Metadata

```typescript
/** Single entry in .agency/credentials.yaml */
interface CredentialMetadataEntry {
  /** Credential type identifier (e.g., 'github-app', 'api-key') */
  type: string;
  /** Storage backend used ('cluster-local') */
  backend: 'cluster-local';
  /** Current status */
  status: 'active' | 'revoked';
  /** ISO 8601 timestamp of last write */
  updatedAt: string;
}

/** Root structure of .agency/credentials.yaml */
interface CredentialsYaml {
  credentials: Record<string, CredentialMetadataEntry>;
}
```

### Storage Interfaces (existing, in `@generacy-ai/credhelper`)

```typescript
/** Read-only credential backend */
interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

/** Read-write credential backend (extends BackendClient) */
interface WritableBackendClient extends BackendClient {
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

### ClusterLocalBackend (extracting to `@generacy-ai/credhelper`)

```typescript
interface ClusterLocalBackendOptions {
  /** Path to encrypted credential store. Default: /var/lib/generacy/credentials.dat */
  dataPath?: string;
  /** Path to AES-256 master key. Default: /var/lib/generacy/master.key */
  keyPath?: string;
}

/**
 * AES-256-GCM encrypted file-backed credential store.
 * Implements WritableBackendClient.
 */
class ClusterLocalBackend implements WritableBackendClient {
  constructor(options?: ClusterLocalBackendOptions);

  /** Load master key and credential cache from disk. Must call before use. */
  init(): Promise<void>;

  /** Retrieve decrypted secret by key. Throws if not found. */
  fetchSecret(key: string): Promise<string>;

  /** Encrypt and persist a secret. Overwrites if exists (idempotent). */
  setSecret(key: string, value: string): Promise<void>;

  /** Remove a secret from the store. */
  deleteSecret(key: string): Promise<void>;
}
```

### CredentialFileStore (extracting to `@generacy-ai/credhelper`)

```typescript
/**
 * Atomic file I/O for the encrypted credential store.
 * Advisory file locking via credentials.dat.lock.
 */
class CredentialFileStore {
  constructor(dataPath: string, keyPath: string);

  /** Read or auto-generate the 32-byte AES-256 master key */
  ensureMasterKey(): Promise<Buffer>;

  /** Load all encrypted entries from disk */
  load(): Promise<Map<string, EncryptedEntry>>;

  /** Atomically save all encrypted entries to disk (temp+fsync+rename) */
  save(entries: Map<string, EncryptedEntry>): Promise<void>;
}
```

### Storage Error

```typescript
/** Error codes for storage operations */
type StorageErrorCode =
  | 'SECRET_NOT_FOUND'
  | 'STORE_CORRUPT'
  | 'STORE_MIGRATION_NEEDED'
  | 'KEY_UNAVAILABLE';

/** Lightweight error class for extracted storage modules */
class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: StorageErrorCode, message: string, details?: Record<string, unknown>);
}
```

## API Types

### PUT /credentials/:credentialId — Request

```typescript
/** Zod schema for PUT credential request body */
const PutCredentialBodySchema = z.object({
  /** Credential type (e.g., 'github-app', 'api-key') */
  type: z.string().min(1),
  /** The secret value to persist */
  value: z.string().min(1),
});

type PutCredentialBody = z.infer<typeof PutCredentialBodySchema>;
```

### PUT /credentials/:credentialId — Response (Success)

```typescript
interface PutCredentialSuccess {
  ok: true;
}
```

### PUT /credentials/:credentialId — Response (Error)

```typescript
interface PutCredentialError {
  error: string;
  code: 'CREDENTIAL_WRITE_FAILED' | 'INVALID_REQUEST';
  /** Which step failed: 'secret-write' | 'metadata-write' | 'validation' */
  failedAt?: string;
}
```

### GET /credentials/:credentialId — Response

```typescript
interface GetCredentialResponse {
  id: string;
  type: string;
  backend: string;
  status: 'active' | 'revoked';
  updatedAt: string;
}
```

### Relay Event Payload

```typescript
/** Emitted on 'cluster.credentials' channel after successful PUT */
interface CredentialWrittenEvent {
  credentialId: string;
  type: string;
  status: 'written';
}
```

## Service Types

### Credential Writer

```typescript
interface WriteCredentialOptions {
  /** Credential identifier (URL param) */
  credentialId: string;
  /** Credential type from request body */
  type: string;
  /** Secret value from request body */
  value: string;
  /** Path to .agency/ directory */
  agencyDir: string;
}

interface WriteCredentialResult {
  ok: true;
}
```

## Validation Rules

| Field | Rule |
|-------|------|
| `credentialId` | Non-empty string (from URL param, regex-matched by router) |
| `type` | Non-empty string (`z.string().min(1)`) |
| `value` | Non-empty string (`z.string().min(1)`) |
| `version` (file envelope) | Must be `1` (reject unknown versions — fail closed) |

## Entity Relationships

```text
PUT Request
  │
  ├── credentialId (URL param)
  │     │
  │     ├──→ CredentialFileEnvelope.entries[credentialId]  (encrypted secret)
  │     │         uses EncryptedEntry { ciphertext, iv, authTag }
  │     │         encrypted by master key at /var/lib/generacy/master.key
  │     │
  │     └──→ CredentialsYaml.credentials[credentialId]    (metadata)
  │               has one CredentialMetadataEntry { type, backend, status, updatedAt }
  │
  └── PutCredentialBody { type, value }
        │
        ├── type  ──→ CredentialMetadataEntry.type
        └── value ──→ encrypt() ──→ EncryptedEntry

ClusterLocalBackend
  ├── has one CredentialFileStore (file I/O)
  ├── has one master key (Buffer, loaded from disk)
  └── has many EncryptedEntry (in-memory cache, Map<string, EncryptedEntry>)
```

---

*Generated by speckit*
