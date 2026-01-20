import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenCache } from '../../../src/auth/token-cache.js';
import type { CachedToken } from '../../../src/auth/types.js';

/**
 * Helper to create a mock CachedToken
 */
function createMockToken(
  installationId: number,
  expiresInMinutes: number = 60
): CachedToken {
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);
  return {
    token: `ghs_mock_token_${installationId}`,
    expiresAt,
    installationId,
    permissions: { issues: 'write', pull_requests: 'write' },
    repositorySelection: 'all',
  };
}

describe('TokenCache', () => {
  let cache: TokenCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new TokenCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Basic Caching', () => {
    it('should store token and retrieve it by installation ID', () => {
      const token = createMockToken(12345);
      cache.set(token);

      const retrieved = cache.get(12345);

      expect(retrieved).toBeDefined();
      expect(retrieved?.token).toBe('ghs_mock_token_12345');
      expect(retrieved?.installationId).toBe(12345);
    });

    it('should return undefined for non-existent installation', () => {
      const retrieved = cache.get(99999);

      expect(retrieved).toBeUndefined();
    });

    it('should store multiple tokens for different installations', () => {
      const token1 = createMockToken(11111);
      const token2 = createMockToken(22222);
      const token3 = createMockToken(33333);

      cache.set(token1);
      cache.set(token2);
      cache.set(token3);

      expect(cache.get(11111)?.token).toBe('ghs_mock_token_11111');
      expect(cache.get(22222)?.token).toBe('ghs_mock_token_22222');
      expect(cache.get(33333)?.token).toBe('ghs_mock_token_33333');
    });

    it('should overwrite existing token for same installation', () => {
      const token1 = createMockToken(12345, 30);
      const token2: CachedToken = {
        ...createMockToken(12345, 60),
        token: 'ghs_new_token',
      };

      cache.set(token1);
      cache.set(token2);

      const retrieved = cache.get(12345);
      expect(retrieved?.token).toBe('ghs_new_token');
    });
  });

  describe('Expiry Tracking', () => {
    it('should return token if not expired', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance time by 30 minutes (still valid)
      vi.advanceTimersByTime(30 * 60 * 1000);

      const retrieved = cache.get(12345);
      expect(retrieved).toBeDefined();
      expect(retrieved?.token).toBe('ghs_mock_token_12345');
    });

    it('should return undefined if token is expired', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance time by 61 minutes (expired)
      vi.advanceTimersByTime(61 * 60 * 1000);

      const retrieved = cache.get(12345);
      expect(retrieved).toBeUndefined();
    });

    it('isExpired() should return true for expired tokens', () => {
      const token = createMockToken(12345, 30); // expires in 30 minutes
      cache.set(token);

      // Advance time past expiration
      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(cache.isExpired(12345)).toBe(true);
    });

    it('isExpired() should return false for valid tokens', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance time but still within validity
      vi.advanceTimersByTime(30 * 60 * 1000);

      expect(cache.isExpired(12345)).toBe(false);
    });

    it('isExpired() should return true for non-existent installation', () => {
      expect(cache.isExpired(99999)).toBe(true);
    });

    it('should handle token that expires exactly now', () => {
      const token = createMockToken(12345, 0); // expires immediately
      cache.set(token);

      expect(cache.isExpired(12345)).toBe(true);
      expect(cache.get(12345)).toBeUndefined();
    });
  });

  describe('Proactive Refresh', () => {
    it('needsRefresh() should return true when token expires in < 10 minutes', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance to 52 minutes (8 minutes left = needs refresh)
      vi.advanceTimersByTime(52 * 60 * 1000);

      expect(cache.needsRefresh(12345)).toBe(true);
    });

    it('needsRefresh() should return false when token has > 10 minutes left', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance to 40 minutes (20 minutes left = no refresh needed)
      vi.advanceTimersByTime(40 * 60 * 1000);

      expect(cache.needsRefresh(12345)).toBe(false);
    });

    it('needsRefresh() should return true for non-existent installation', () => {
      expect(cache.needsRefresh(99999)).toBe(true);
    });

    it('needsRefresh() should return true when exactly at 10 minute threshold', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance to exactly 50 minutes (10 minutes left)
      vi.advanceTimersByTime(50 * 60 * 1000);

      // At exactly 10 minutes, it should be considered needing refresh
      expect(cache.needsRefresh(12345)).toBe(true);
    });

    it('needsRefresh() should return false when just over 10 minutes left', () => {
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cache.set(token);

      // Advance to 49 minutes (11 minutes left)
      vi.advanceTimersByTime(49 * 60 * 1000);

      expect(cache.needsRefresh(12345)).toBe(false);
    });

    it('should trigger refresh callback when approaching expiry', async () => {
      const refreshCallback = vi.fn().mockResolvedValue(createMockToken(12345, 60));

      const cacheWithCallback = new TokenCache({ onRefreshNeeded: refreshCallback });
      const token = createMockToken(12345, 15); // expires in 15 minutes
      cacheWithCallback.set(token);

      // Advance to 6 minutes (9 minutes left = needs refresh)
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Trigger check that would invoke callback
      await cacheWithCallback.getWithRefresh(12345);

      expect(refreshCallback).toHaveBeenCalledWith(12345);
    });

    it('should not trigger refresh callback if token has plenty of time', async () => {
      const refreshCallback = vi.fn().mockResolvedValue(createMockToken(12345, 60));

      const cacheWithCallback = new TokenCache({ onRefreshNeeded: refreshCallback });
      const token = createMockToken(12345, 60); // expires in 60 minutes
      cacheWithCallback.set(token);

      // Only advance 10 minutes (50 minutes left)
      vi.advanceTimersByTime(10 * 60 * 1000);

      await cacheWithCallback.getWithRefresh(12345);

      expect(refreshCallback).not.toHaveBeenCalled();
    });

    it('should update cache with refreshed token', async () => {
      const newToken: CachedToken = {
        ...createMockToken(12345, 60),
        token: 'ghs_refreshed_token',
      };
      const refreshCallback = vi.fn().mockResolvedValue(newToken);

      const cacheWithCallback = new TokenCache({ onRefreshNeeded: refreshCallback });
      const token = createMockToken(12345, 5); // expires in 5 minutes
      cacheWithCallback.set(token);

      const result = await cacheWithCallback.getWithRefresh(12345);

      expect(result?.token).toBe('ghs_refreshed_token');
      expect(cacheWithCallback.get(12345)?.token).toBe('ghs_refreshed_token');
    });
  });

  describe('Token Invalidation', () => {
    it('clear() should remove token for installation', () => {
      const token1 = createMockToken(11111);
      const token2 = createMockToken(22222);

      cache.set(token1);
      cache.set(token2);

      cache.clear(11111);

      expect(cache.get(11111)).toBeUndefined();
      expect(cache.get(22222)).toBeDefined();
    });

    it('clear() should not throw for non-existent installation', () => {
      expect(() => cache.clear(99999)).not.toThrow();
    });

    it('clearAll() should remove all tokens', () => {
      const token1 = createMockToken(11111);
      const token2 = createMockToken(22222);
      const token3 = createMockToken(33333);

      cache.set(token1);
      cache.set(token2);
      cache.set(token3);

      cache.clearAll();

      expect(cache.get(11111)).toBeUndefined();
      expect(cache.get(22222)).toBeUndefined();
      expect(cache.get(33333)).toBeUndefined();
    });

    it('clearAll() should work on empty cache', () => {
      expect(() => cache.clearAll()).not.toThrow();
    });

    it('should allow setting new token after clear', () => {
      const token = createMockToken(12345);
      cache.set(token);
      cache.clear(12345);

      const newToken: CachedToken = {
        ...createMockToken(12345, 60),
        token: 'ghs_new_token_after_clear',
      };
      cache.set(newToken);

      expect(cache.get(12345)?.token).toBe('ghs_new_token_after_clear');
    });

    it('should allow setting tokens after clearAll', () => {
      const token = createMockToken(12345);
      cache.set(token);
      cache.clearAll();

      const newToken = createMockToken(67890);
      cache.set(newToken);

      expect(cache.get(67890)).toBeDefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large installation IDs', () => {
      const largeId = Number.MAX_SAFE_INTEGER;
      const token = createMockToken(largeId);
      cache.set(token);

      expect(cache.get(largeId)).toBeDefined();
      expect(cache.get(largeId)?.installationId).toBe(largeId);
    });

    it('should handle token with all permissions', () => {
      const token: CachedToken = {
        token: 'ghs_full_perms',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        installationId: 12345,
        permissions: {
          issues: 'write',
          pull_requests: 'write',
          contents: 'write',
          metadata: 'read',
          actions: 'write',
        },
        repositorySelection: 'selected',
      };

      cache.set(token);
      const retrieved = cache.get(12345);

      expect(retrieved?.permissions).toEqual(token.permissions);
      expect(retrieved?.repositorySelection).toBe('selected');
    });

    it('should preserve token metadata through cache operations', () => {
      const token: CachedToken = {
        token: 'ghs_metadata_test',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        installationId: 12345,
        permissions: { issues: 'write' },
        repositorySelection: 'all',
      };

      cache.set(token);
      const retrieved = cache.get(12345);

      expect(retrieved).toEqual(token);
    });
  });
});
