import type { CachedToken } from './types.js';

/**
 * Configuration options for the TokenCache
 */
export interface TokenCacheOptions {
  /**
   * Callback when a token needs to be refreshed
   * Called when getWithRefresh() is invoked and token is within refresh window
   */
  onRefreshNeeded?: (installationId: number) => Promise<CachedToken>;

  /**
   * Refresh threshold in milliseconds (default: 10 minutes = 600000ms)
   * Tokens will be proactively refreshed when this much time remains
   */
  refreshThresholdMs?: number;
}

/**
 * In-memory token cache with expiry tracking and proactive refresh
 *
 * Caches installation access tokens with their expiration times.
 * Supports proactive refresh when tokens are approaching expiry.
 */
export class TokenCache {
  private readonly cache = new Map<number, CachedToken>();
  private readonly options: Required<Pick<TokenCacheOptions, 'refreshThresholdMs'>> & TokenCacheOptions;

  /** Default refresh threshold: 10 minutes before expiry */
  private static readonly DEFAULT_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

  constructor(options: TokenCacheOptions = {}) {
    this.options = {
      refreshThresholdMs: options.refreshThresholdMs ?? TokenCache.DEFAULT_REFRESH_THRESHOLD_MS,
      onRefreshNeeded: options.onRefreshNeeded,
    };
  }

  /**
   * Get a cached token by installation ID
   * Returns undefined if token doesn't exist or is expired
   */
  get(installationId: number): CachedToken | undefined {
    const token = this.cache.get(installationId);
    if (!token) {
      return undefined;
    }

    // Return undefined if expired
    if (this.isExpired(installationId)) {
      this.cache.delete(installationId);
      return undefined;
    }

    return token;
  }

  /**
   * Get a token with automatic refresh if needed
   * If the token is within the refresh threshold, calls the refresh callback
   */
  async getWithRefresh(installationId: number): Promise<CachedToken | undefined> {
    const token = this.get(installationId);

    // If no token or no callback, just return what we have
    if (!token || !this.options.onRefreshNeeded) {
      return token;
    }

    // Check if we need to refresh
    if (this.needsRefresh(installationId)) {
      try {
        const newToken = await this.options.onRefreshNeeded(installationId);
        this.set(newToken);
        return newToken;
      } catch {
        // If refresh fails, return existing token if still valid
        return token;
      }
    }

    return token;
  }

  /**
   * Store a token in the cache
   */
  set(token: CachedToken): void {
    this.cache.set(token.installationId, token);
  }

  /**
   * Check if a token is expired
   * Returns true if token doesn't exist or is past expiration
   */
  isExpired(installationId: number): boolean {
    const token = this.cache.get(installationId);
    if (!token) {
      return true;
    }
    return token.expiresAt.getTime() <= Date.now();
  }

  /**
   * Check if a token needs to be refreshed
   * Returns true if token doesn't exist, is expired, or is within the refresh threshold
   */
  needsRefresh(installationId: number): boolean {
    const token = this.cache.get(installationId);
    if (!token) {
      return true;
    }

    const timeUntilExpiry = token.expiresAt.getTime() - Date.now();
    return timeUntilExpiry <= this.options.refreshThresholdMs;
  }

  /**
   * Remove a token from the cache
   */
  clear(installationId: number): void {
    this.cache.delete(installationId);
  }

  /**
   * Remove all tokens from the cache
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * Get the number of cached tokens
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Check if a token exists for the given installation (regardless of expiry)
   */
  has(installationId: number): boolean {
    return this.cache.has(installationId);
  }
}
