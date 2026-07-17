import { describe, expect, it, vi } from 'vitest';
import { createGhResponseCache } from '../gh/cache.js';

describe('GhResponseCache', () => {
  it('serves cached value inside TTL and re-fetches after TTL', async () => {
    let clock = 1000;
    const cache = createGhResponseCache({ ttlMs: 20_000, now: () => clock });
    const fetcher = vi.fn(async () => 'v1');

    const a = await cache.getOrFetch('k', fetcher);
    expect(a).toBe('v1');
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock += 19_000;
    const b = await cache.getOrFetch('k', fetcher);
    expect(b).toBe('v1');
    expect(fetcher).toHaveBeenCalledTimes(1);

    clock += 2_000;
    const c = await cache.getOrFetch('k', fetcher);
    expect(c).toBe('v1');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('coalesces in-flight fetches for the same key', async () => {
    const cache = createGhResponseCache();
    let calls = 0;
    let release: ((v: string) => void) | undefined;
    const promise = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fetcher = async (): Promise<string> => {
      calls++;
      return promise;
    };
    const all = Promise.all(
      Array.from({ length: 10 }, () => cache.getOrFetch('k', fetcher)),
    );
    release!('v');
    const results = await all;
    expect(calls).toBe(1);
    expect(results).toEqual(Array(10).fill('v'));
  });

  it('does not cache rejections', async () => {
    const cache = createGhResponseCache();
    let call = 0;
    const fetcher = async (): Promise<string> => {
      call++;
      if (call === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.getOrFetch('k', fetcher)).rejects.toThrow('boom');
    await expect(cache.getOrFetch('k', fetcher)).resolves.toBe('ok');
    expect(call).toBe(2);
  });

  it('invalidate(k) forces re-fetch on next call', async () => {
    const cache = createGhResponseCache();
    let call = 0;
    const fetcher = async (): Promise<string> => `v${++call}`;
    await cache.getOrFetch('k', fetcher);
    cache.invalidate('k');
    const next = await cache.getOrFetch('k', fetcher);
    expect(next).toBe('v2');
  });

  it('invalidatePrefix removes matching entries only', async () => {
    const cache = createGhResponseCache();
    await cache.getOrFetch('getIssue:o/r#1', async () => 1);
    await cache.getOrFetch('getIssue:o/r#2', async () => 2);
    await cache.getOrFetch('getPullRequest:o/r#1', async () => 3);
    expect(cache.size()).toBe(3);
    cache.invalidatePrefix('getIssue:');
    expect(cache.size()).toBe(1);
    const v = await cache.getOrFetch('getPullRequest:o/r#1', async () => 999);
    expect(v).toBe(3);
  });

  it('size() reflects live count', async () => {
    const cache = createGhResponseCache();
    expect(cache.size()).toBe(0);
    await cache.getOrFetch('a', async () => 1);
    await cache.getOrFetch('b', async () => 2);
    expect(cache.size()).toBe(2);
    cache.invalidate('a');
    expect(cache.size()).toBe(1);
  });
});
