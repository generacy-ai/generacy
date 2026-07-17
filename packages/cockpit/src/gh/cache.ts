export interface GhCacheOptions {
  ttlMs?: number;
  now?: () => number;
  logger?: { debug?: (msg: string) => void };
}

export interface GhResponseCache {
  getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  invalidatePrefix(prefix: string): void;
  size(): number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 20_000;

export function createGhResponseCache(opts: GhCacheOptions = {}): GhResponseCache {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error(`GhResponseCache: ttlMs must be positive, got ${ttlMs}`);
  }
  const now = opts.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<unknown>>();

  function getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const existing = entries.get(key);
    if (existing != null && existing.expiresAt > now()) {
      return Promise.resolve(existing.value as T);
    }
    if (existing != null) {
      entries.delete(key);
    }
    const pending = inflight.get(key);
    if (pending != null) {
      return pending as Promise<T>;
    }
    const promise = fetcher()
      .then((value) => {
        entries.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise as Promise<unknown>);
    return promise;
  }

  function invalidate(key: string): void {
    entries.delete(key);
  }

  function invalidatePrefix(prefix: string): void {
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
      }
    }
  }

  function size(): number {
    return entries.size;
  }

  return { getOrFetch, invalidate, invalidatePrefix, size };
}
