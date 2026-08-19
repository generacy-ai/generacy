import { describe, it, expect, vi } from 'vitest';
import type { Redis } from 'ioredis';
import { PhaseTrackerService } from '../phase-tracker-service.js';

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

/**
 * Minimal ioredis stand-in covering only the string commands the raw-key
 * methods (#1107) exercise: GET / SET (with EX) / DEL. Records the TTL passed
 * to SET so the passthrough can be asserted.
 */
function makeFakeRedis() {
  const store = new Map<string, string>();
  const ttls: Array<{ key: string; value: string; ttl: number }> = [];
  const redis = {
    async get(key: string): Promise<string | null> {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string, _ex: 'EX', ttl: number): Promise<'OK'> {
      store.set(key, value);
      ttls.push({ key, value, ttl });
      return 'OK';
    },
    async del(key: string): Promise<number> {
      return store.delete(key) ? 1 : 0;
    },
  };
  return { redis: redis as unknown as Redis, store, ttls };
}

describe('PhaseTrackerService raw string get/set/clear (#1107)', () => {
  it('round-trips a value through setValueRaw / getValueRaw', async () => {
    const { redis } = makeFakeRedis();
    const svc = new PhaseTrackerService(makeLogger(), redis);

    expect(await svc.getValueRaw('phase-start-ref:o:r:1:implement')).toBeNull();

    await svc.setValueRaw('phase-start-ref:o:r:1:implement', 'abc123', 604800);
    expect(await svc.getValueRaw('phase-start-ref:o:r:1:implement')).toBe('abc123');
  });

  it('passes the TTL through to SET ... EX', async () => {
    const { redis, ttls } = makeFakeRedis();
    const svc = new PhaseTrackerService(makeLogger(), redis);

    await svc.setValueRaw('k', 'v', 604800);
    expect(ttls).toEqual([{ key: 'k', value: 'v', ttl: 604800 }]);
  });

  it('clearRaw removes the key', async () => {
    const { redis } = makeFakeRedis();
    const svc = new PhaseTrackerService(makeLogger(), redis);

    await svc.setValueRaw('k', 'v', 604800);
    await svc.clearRaw('k');
    expect(await svc.getValueRaw('k')).toBeNull();
  });

  it('getValueRaw returns null and setValueRaw is a no-op when Redis is unavailable', async () => {
    const logger = makeLogger();
    const svc = new PhaseTrackerService(logger, null);

    expect(await svc.getValueRaw('k')).toBeNull();
    await expect(svc.setValueRaw('k', 'v', 604800)).resolves.toBeUndefined();
    await expect(svc.clearRaw('k')).resolves.toBeUndefined();
  });

  it('getValueRaw returns null when the underlying GET throws', async () => {
    const logger = makeLogger();
    const redis = {
      get: vi.fn().mockRejectedValue(new Error('boom')),
    } as unknown as Redis;
    const svc = new PhaseTrackerService(logger, redis);

    expect(await svc.getValueRaw('k')).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
