# Contract: `GhResponseCache`

Same-process, TTL-based, read-through cache for GraphQL-backed `gh` wrapper methods.

## Public API

```ts
export interface GhCacheOptions {
  ttlMs?: number;              // default 20_000
  now?: () => number;          // default Date.now
  logger?: { debug?: (msg: string) => void };
}

export interface GhResponseCache {
  getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  invalidatePrefix(prefix: string): void;
  size(): number;
}

export function createGhResponseCache(opts?: GhCacheOptions): GhResponseCache;
```

## Semantics

### `getOrFetch(key, fetcher)`

1. Look up `key`. If present and `entry.expiresAt > now()`, return `entry.value`.
2. If present but expired, delete + fall through.
3. If a `fetcher` is already in flight for `key`, return the in-flight Promise (in-flight coalescing).
4. Otherwise, invoke `fetcher`. On resolve: cache the value with `expiresAt = now() + ttlMs`. On reject: do NOT cache the error; propagate the rejection. Concurrent callers that joined the in-flight Promise see the same rejection.

### `invalidate(key)`

- Remove the entry if present. No-op if absent.
- Does NOT affect an in-flight fetcher — a concurrent `getOrFetch` that just started fetching completes normally and repopulates the cache. This is intentional: invalidation is "the value I have is stale", not "cancel any pending refresh".

### `invalidatePrefix(prefix)`

- Remove every entry whose key starts with `prefix`. O(n) — only called from write paths where n is small.
- Same in-flight semantics as `invalidate`.

### `size()`

- Test-only. Returns current entry count. Not called in production.

## Invariants

- **I-1**: `getOrFetch` never returns a stale value past its TTL.
- **I-2**: For a given key, at most one fetcher runs at a time (coalescing).
- **I-3**: A rejected fetcher does not cache a rejection — the next call re-attempts.
- **I-4**: `invalidate(k)` returns synchronously; the next `getOrFetch(k)` starts a fresh fetcher (unless another one raced in and cached first).
- **I-5**: No LRU eviction — TTL alone bounds cache size. In practice the caller (poll loop over refs) bounds the key set.

## Key convention

`${methodName}:${repo}#${number}`

Callers must colocate the key construction with the wrapper method. Cache does not enforce format.

## Caller responsibilities

- Wrapper methods that mutate server state MUST call `invalidate` before returning (not after — a race between "value written" and "cache still returns pre-write value" is worse than a spurious re-fetch).
- Callers that construct their own `GhCliWrapper(runner)` without providing a cache get today's behavior (no caching). Callers who opt into the cache pass one in through the wrapper constructor.

## Test seams

- `now: () => number` — advance test clock to cross the TTL boundary.
- `size()` — assert cache growth in tests.
