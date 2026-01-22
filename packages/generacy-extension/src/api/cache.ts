/**
 * Local caching for offline mode using VS Code Memento API
 */
import * as vscode from 'vscode';

/**
 * Cached data entry
 */
export interface CachedData<T = unknown> {
  /** Cached data */
  data: T;

  /** Timestamp when cached */
  cachedAt: number;

  /** Time-to-live in milliseconds */
  ttl: number;

  /** Optional metadata */
  metadata?: {
    /** API endpoint that provided this data */
    source?: string;

    /** ETag or version for cache validation */
    version?: string;
  };
}

/**
 * Cache entry status
 */
export interface CacheStatus {
  /** Whether data exists in cache */
  exists: boolean;

  /** Whether cached data is still valid */
  valid: boolean;

  /** Age of cached data in milliseconds */
  age?: number;

  /** Time until expiration in milliseconds */
  expiresIn?: number;
}

/**
 * TTL configuration for different data types
 */
export const CACHE_TTL = {
  /** Organization info - rarely changes */
  org: 60 * 60 * 1000, // 1 hour

  /** Queue items - frequently updated */
  queue: 5 * 60 * 1000, // 5 minutes

  /** Integration status - semi-static */
  integrations: 15 * 60 * 1000, // 15 minutes

  /** User profile - rarely changes */
  user: 60 * 60 * 1000, // 1 hour

  /** Workflow definitions */
  workflows: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * Cache manager using VS Code global state
 */
export class CacheManager {
  private readonly cacheKeyPrefix = 'generacy.cache';

  constructor(private readonly globalState: vscode.Memento) {}

  /**
   * Get data from cache
   */
  public async get<T>(key: string): Promise<T | undefined> {
    const cacheKey = this.getCacheKey(key);
    const cached = this.globalState.get<CachedData<T>>(cacheKey);

    if (!cached) {
      return undefined;
    }

    // Check if expired
    const age = Date.now() - cached.cachedAt;
    if (age > cached.ttl) {
      // Evict expired entry
      await this.globalState.update(cacheKey, undefined);
      return undefined;
    }

    return cached.data;
  }

  /**
   * Set data in cache
   */
  public async set<T>(
    key: string,
    data: T,
    ttl: number,
    metadata?: CachedData<T>['metadata']
  ): Promise<void> {
    const cacheKey = this.getCacheKey(key);
    const entry: CachedData<T> = {
      data,
      cachedAt: Date.now(),
      ttl,
      metadata,
    };

    await this.globalState.update(cacheKey, entry);
  }

  /**
   * Get cache status for a key
   */
  public getStatus(key: string): CacheStatus {
    const cacheKey = this.getCacheKey(key);
    const cached = this.globalState.get<CachedData>(cacheKey);

    if (!cached) {
      return {
        exists: false,
        valid: false,
      };
    }

    const age = Date.now() - cached.cachedAt;
    const valid = age <= cached.ttl;
    const expiresIn = Math.max(0, cached.ttl - age);

    return {
      exists: true,
      valid,
      age,
      expiresIn,
    };
  }

  /**
   * Clear cache entry
   */
  public async clear(key: string): Promise<void> {
    const cacheKey = this.getCacheKey(key);
    await this.globalState.update(cacheKey, undefined);
  }

  /**
   * Clear all cache entries
   */
  public async clearAll(): Promise<void> {
    const keys = this.globalState.keys();
    const cacheKeys = keys.filter((key) => key.startsWith(this.cacheKeyPrefix));

    for (const key of cacheKeys) {
      await this.globalState.update(key, undefined);
    }
  }

  /**
   * Get cache statistics
   */
  public getStatistics(): {
    totalEntries: number;
    validEntries: number;
    expiredEntries: number;
    totalSize: number;
  } {
    const keys = this.globalState.keys();
    const cacheKeys = keys.filter((key) => key.startsWith(this.cacheKeyPrefix));

    let validEntries = 0;
    let expiredEntries = 0;
    let totalSize = 0;

    for (const key of cacheKeys) {
      const cached = this.globalState.get<CachedData>(key);
      if (cached) {
        const age = Date.now() - cached.cachedAt;
        if (age <= cached.ttl) {
          validEntries++;
        } else {
          expiredEntries++;
        }

        // Estimate size
        totalSize += JSON.stringify(cached).length;
      }
    }

    return {
      totalEntries: cacheKeys.length,
      validEntries,
      expiredEntries,
      totalSize,
    };
  }

  /**
   * Evict all expired entries
   */
  public async evictExpired(): Promise<number> {
    const keys = this.globalState.keys();
    const cacheKeys = keys.filter((key) => key.startsWith(this.cacheKeyPrefix));

    let evicted = 0;
    for (const key of cacheKeys) {
      const cached = this.globalState.get<CachedData>(key);
      if (cached) {
        const age = Date.now() - cached.cachedAt;
        if (age > cached.ttl) {
          await this.globalState.update(key, undefined);
          evicted++;
        }
      }
    }

    return evicted;
  }

  /**
   * Get full cache key with prefix
   */
  private getCacheKey(key: string): string {
    return `${this.cacheKeyPrefix}.${key}`;
  }
}

// Singleton instance
let cacheManager: CacheManager | undefined;

/**
 * Initialize the cache manager
 */
export function initializeCacheManager(
  globalState: vscode.Memento
): CacheManager {
  cacheManager = new CacheManager(globalState);
  return cacheManager;
}

/**
 * Get the cache manager instance
 */
export function getCacheManager(): CacheManager {
  if (!cacheManager) {
    throw new Error(
      'Cache manager not initialized. Call initializeCacheManager first.'
    );
  }
  return cacheManager;
}

/**
 * Convenience function to get from cache
 */
export async function getFromCache<T>(key: string): Promise<T | undefined> {
  return getCacheManager().get<T>(key);
}

/**
 * Convenience function to set cache
 */
export async function setCache<T>(
  key: string,
  data: T,
  ttl: number,
  metadata?: CachedData<T>['metadata']
): Promise<void> {
  return getCacheManager().set(key, data, ttl, metadata);
}

/**
 * Convenience function to clear cache
 */
export async function clearCache(key: string): Promise<void> {
  return getCacheManager().clear(key);
}
