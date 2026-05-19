/**
 * Interface contracts for #491: Cluster-Local Credhelper Backend
 *
 * These are design-time contracts — not compiled source code.
 * The actual implementation lives in packages/credhelper/src/types/context.ts
 * and packages/credhelper-daemon/src/backends/.
 */

// ─── Shared types package (@generacy-ai/credhelper) ───

/**
 * Existing read-only backend interface (unchanged).
 */
export interface BackendClient {
  fetchSecret(key: string): Promise<string>;
}

/**
 * NEW: Writable backend interface for backends that support mutation.
 * Extends BackendClient — all writable backends are also readable.
 */
export interface WritableBackendClient extends BackendClient {
  /**
   * Encrypt and store a credential value.
   * @param key - Credential identifier (e.g., "github-pat-main")
   * @param value - Plaintext secret value (never logged)
   */
  setSecret(key: string, value: string): Promise<void>;

  /**
   * Remove a credential from the store.
   * @param key - Credential identifier
   * @throws BACKEND_SECRET_NOT_FOUND if key does not exist
   */
  deleteSecret(key: string): Promise<void>;
}

// ─── Backend factory (credhelper-daemon) ───

/**
 * Existing factory interface (unchanged signature).
 * The return type remains BackendClient — callers that need write access
 * must type-narrow to WritableBackendClient at the call site.
 */
export interface BackendClientFactory {
  create(backend: BackendEntry): BackendClient;
}

// ─── Backend entry schema (unchanged) ───

export interface BackendEntry {
  id: string;
  type: string; // 'env' | 'cluster-local'
  endpoint?: string;
  auth?: { mode: string; [key: string]: unknown };
}

// ─── Credential file envelope (on-disk format) ───

export interface EncryptedEntry {
  /** Base64-encoded AES-256-GCM ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector */
  iv: string;
  /** Base64-encoded 16-byte GCM authentication tag */
  authTag: string;
}

export interface CredentialFileEnvelope {
  /** File format version. Must be 1 for v1.5. */
  version: number;
  /** Map of credential key to encrypted entry */
  entries: Record<string, EncryptedEntry>;
}

// ─── Error codes ───

export type ClusterLocalErrorCode =
  | 'CREDENTIAL_STORE_CORRUPT'          // Invalid JSON in credentials.dat
  | 'CREDENTIAL_STORE_MIGRATION_NEEDED' // Unknown version number
  | 'BACKEND_SECRET_NOT_FOUND'          // Key not in store (reuses existing code)
  | 'BACKEND_UNREACHABLE';              // Master key unreadable / permission denied
