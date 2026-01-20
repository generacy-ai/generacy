import { describe, it, expect, beforeEach } from 'vitest';
import {
  hashApiKey,
  compareApiKeys,
  validateApiKey,
  createAuthContextFromApiKey,
  hasScope,
  hasAnyScope,
  InMemoryApiKeyStore,
} from '../../../src/auth/api-key.js';
import type { ApiKeyCredential, AuthContext } from '../../../src/types/index.js';

describe('api-key', () => {
  describe('hashApiKey', () => {
    it('should hash an API key', () => {
      const hash = hashApiKey('test-api-key');
      expect(hash).toHaveLength(64); // SHA256 hex is 64 chars
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('should produce consistent hashes', () => {
      const hash1 = hashApiKey('test-api-key');
      const hash2 = hashApiKey('test-api-key');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different keys', () => {
      const hash1 = hashApiKey('test-api-key-1');
      const hash2 = hashApiKey('test-api-key-2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('compareApiKeys', () => {
    it('should return true for matching hashes', () => {
      const hash = hashApiKey('test-api-key');
      expect(compareApiKeys(hash, hash)).toBe(true);
    });

    it('should return false for non-matching hashes', () => {
      const hash1 = hashApiKey('test-api-key-1');
      const hash2 = hashApiKey('test-api-key-2');
      expect(compareApiKeys(hash1, hash2)).toBe(false);
    });

    it('should return false for different length strings', () => {
      expect(compareApiKeys('short', 'longer-string')).toBe(false);
    });
  });

  describe('InMemoryApiKeyStore', () => {
    let store: InMemoryApiKeyStore;

    beforeEach(() => {
      store = new InMemoryApiKeyStore();
    });

    it('should store and retrieve API keys', async () => {
      store.addKey('test-key', {
        name: 'Test Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });

      const hashedKey = hashApiKey('test-key');
      const credential = await store.get(hashedKey);

      expect(credential).not.toBeNull();
      expect(credential?.name).toBe('Test Key');
    });

    it('should return null for unknown keys', async () => {
      const result = await store.get('unknown-hash');
      expect(result).toBeNull();
    });

    it('should update last used timestamp', async () => {
      store.addKey('test-key', {
        name: 'Test Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });

      const hashedKey = hashApiKey('test-key');
      const timestamp = new Date().toISOString();
      await store.updateLastUsed(hashedKey, timestamp);

      const credential = await store.get(hashedKey);
      expect(credential?.lastUsedAt).toBe(timestamp);
    });

    it('should clear all keys', async () => {
      store.addKey('test-key', {
        name: 'Test Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });

      store.clear();

      const hashedKey = hashApiKey('test-key');
      const result = await store.get(hashedKey);
      expect(result).toBeNull();
    });
  });

  describe('validateApiKey', () => {
    let store: InMemoryApiKeyStore;

    beforeEach(() => {
      store = new InMemoryApiKeyStore();
      store.addKey('valid-key', {
        name: 'Valid Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read'],
      });
    });

    it('should validate a valid API key', async () => {
      const result = await validateApiKey('valid-key', store);
      expect(result.valid).toBe(true);
      expect(result.credential?.name).toBe('Valid Key');
    });

    it('should reject an invalid API key', async () => {
      const result = await validateApiKey('invalid-key', store);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid API key');
    });

    it('should reject empty API key', async () => {
      const result = await validateApiKey('', store);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('API key is required');
    });

    it('should reject expired API key', async () => {
      const pastDate = new Date();
      pastDate.setFullYear(pastDate.getFullYear() - 1);

      store.addKey('expired-key', {
        name: 'Expired Key',
        createdAt: new Date().toISOString(),
        expiresAt: pastDate.toISOString(),
        scopes: ['workflows:read'],
      });

      const result = await validateApiKey('expired-key', store);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('API key has expired');
    });

    it('should accept non-expired API key', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      store.addKey('future-key', {
        name: 'Future Key',
        createdAt: new Date().toISOString(),
        expiresAt: futureDate.toISOString(),
        scopes: ['workflows:read'],
      });

      const result = await validateApiKey('future-key', store);
      expect(result.valid).toBe(true);
    });
  });

  describe('createAuthContextFromApiKey', () => {
    it('should create auth context from credential', () => {
      const credential: ApiKeyCredential = {
        key: 'hashed-key',
        name: 'Test Key',
        createdAt: new Date().toISOString(),
        scopes: ['workflows:read', 'queue:write'],
      };

      const context = createAuthContextFromApiKey(credential);

      expect(context.userId).toBe('apikey:Test Key');
      expect(context.method).toBe('api-key');
      expect(context.scopes).toEqual(['workflows:read', 'queue:write']);
      expect(context.apiKeyName).toBe('Test Key');
    });
  });

  describe('hasScope', () => {
    it('should return true if context has scope', () => {
      const context: AuthContext = {
        userId: 'test',
        method: 'api-key',
        scopes: ['workflows:read', 'queue:write'],
      };

      expect(hasScope(context, 'workflows:read')).toBe(true);
      expect(hasScope(context, 'queue:write')).toBe(true);
    });

    it('should return false if context lacks scope', () => {
      const context: AuthContext = {
        userId: 'test',
        method: 'api-key',
        scopes: ['workflows:read'],
      };

      expect(hasScope(context, 'workflows:write')).toBe(false);
    });

    it('should grant all scopes if admin', () => {
      const context: AuthContext = {
        userId: 'test',
        method: 'api-key',
        scopes: ['admin'],
      };

      expect(hasScope(context, 'workflows:read')).toBe(true);
      expect(hasScope(context, 'workflows:write')).toBe(true);
      expect(hasScope(context, 'queue:read')).toBe(true);
      expect(hasScope(context, 'admin')).toBe(true);
    });
  });

  describe('hasAnyScope', () => {
    it('should return true if context has any of the scopes', () => {
      const context: AuthContext = {
        userId: 'test',
        method: 'api-key',
        scopes: ['workflows:read'],
      };

      expect(hasAnyScope(context, ['workflows:read', 'workflows:write'])).toBe(true);
    });

    it('should return false if context has none of the scopes', () => {
      const context: AuthContext = {
        userId: 'test',
        method: 'api-key',
        scopes: ['queue:read'],
      };

      expect(hasAnyScope(context, ['workflows:read', 'workflows:write'])).toBe(false);
    });
  });
});
