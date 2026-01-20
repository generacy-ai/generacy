import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyCredential, ApiScope, AuthContext } from '../types/index.js';

/**
 * Header name for API key authentication
 */
export const API_KEY_HEADER = 'x-api-key';

/**
 * API key storage interface
 */
export interface ApiKeyStore {
  /** Get API key credential by hashed key */
  get(hashedKey: string): Promise<ApiKeyCredential | null>;
  /** Update last used timestamp */
  updateLastUsed(hashedKey: string, timestamp: string): Promise<void>;
}

/**
 * In-memory API key store for development/testing
 */
export class InMemoryApiKeyStore implements ApiKeyStore {
  private keys: Map<string, ApiKeyCredential> = new Map();

  /**
   * Add an API key to the store
   */
  addKey(plainKey: string, credential: Omit<ApiKeyCredential, 'key'>): void {
    const hashedKey = hashApiKey(plainKey);
    this.keys.set(hashedKey, {
      ...credential,
      key: hashedKey,
    });
  }

  async get(hashedKey: string): Promise<ApiKeyCredential | null> {
    return this.keys.get(hashedKey) ?? null;
  }

  async updateLastUsed(hashedKey: string, timestamp: string): Promise<void> {
    const credential = this.keys.get(hashedKey);
    if (credential) {
      credential.lastUsedAt = timestamp;
    }
  }

  /**
   * Clear all keys (for testing)
   */
  clear(): void {
    this.keys.clear();
  }
}

/**
 * Hash an API key for storage
 */
export function hashApiKey(plainKey: string): string {
  return createHash('sha256').update(plainKey).digest('hex');
}

/**
 * Compare hashed API keys in constant time
 */
export function compareApiKeys(hash1: string, hash2: string): boolean {
  if (hash1.length !== hash2.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(hash1), Buffer.from(hash2));
}

/**
 * Validation result for API key
 */
export interface ApiKeyValidationResult {
  valid: boolean;
  credential?: ApiKeyCredential;
  error?: string;
}

/**
 * Validate an API key
 */
export async function validateApiKey(
  plainKey: string,
  store: ApiKeyStore
): Promise<ApiKeyValidationResult> {
  if (!plainKey || typeof plainKey !== 'string') {
    return { valid: false, error: 'API key is required' };
  }

  const hashedKey = hashApiKey(plainKey);
  const credential = await store.get(hashedKey);

  if (!credential) {
    return { valid: false, error: 'Invalid API key' };
  }

  // Check expiration
  if (credential.expiresAt) {
    const expiresAt = new Date(credential.expiresAt);
    if (expiresAt < new Date()) {
      return { valid: false, error: 'API key has expired' };
    }
  }

  // Update last used timestamp
  await store.updateLastUsed(hashedKey, new Date().toISOString());

  return { valid: true, credential };
}

/**
 * Create auth context from API key credential
 */
export function createAuthContextFromApiKey(credential: ApiKeyCredential): AuthContext {
  return {
    userId: `apikey:${credential.name}`,
    method: 'api-key',
    scopes: credential.scopes,
    apiKeyName: credential.name,
  };
}

/**
 * Check if auth context has required scope
 */
export function hasScope(context: AuthContext, requiredScope: ApiScope): boolean {
  // Admin scope has access to everything
  if (context.scopes.includes('admin')) {
    return true;
  }

  return context.scopes.includes(requiredScope);
}

/**
 * Check if auth context has any of the required scopes
 */
export function hasAnyScope(context: AuthContext, requiredScopes: ApiScope[]): boolean {
  return requiredScopes.some((scope) => hasScope(context, scope));
}
