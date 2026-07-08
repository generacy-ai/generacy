import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * Unit tests for RedisQueueAdapter.enqueueIfAbsent + hasInFlight + SET maintenance
 * across the full queue lifecycle (enqueue → claim → complete/release).
 *
 * The mock Redis maintains stateful sorted set (pending), hash (claimed:<worker>),
 * and set (in-flight-items) so we can assert SET invariants after each transition
 * without pulling in ioredis-mock. Lua-body atomicity (SISMEMBER + SADD + ZADD) is
 * modeled by the mock's `enqueueIfAbsent` doing exactly that in one synchronous
 * function — mirroring the real Lua script's contract.
 */

interface MockState {
  pending: Map<string, { score: number; member: string }>;       // itemKey → ZSET entry
  claimed: Map<string, Map<string, string>>;                     // workerId → itemKey → serialized
  inFlight: Set<string>;                                         // itemKey members
  deadLetter: { score: number; member: string }[];
  heartbeats: Set<string>;
}

function createMockRedisWithState() {
  const state: MockState = {
    pending: new Map(),
    claimed: new Map(),
    inFlight: new Set(),
    deadLetter: [],
    heartbeats: new Set(),
  };

  // Track calls for observability assertions
  const zaddSpy = vi.fn();
  const sremSpy = vi.fn();

  const redis: Record<string, unknown> = {
    zadd: vi.fn(async (key: string, score: number | string, member: string) => {
      zaddSpy(key, score, member);
      const parsed: SerializedQueueItem = JSON.parse(member);
      if (key === 'orchestrator:queue:pending') {
        state.pending.set(parsed.itemKey, { score: Number(score), member });
      } else if (key === 'orchestrator:queue:dead-letter') {
        state.deadLetter.push({ score: Number(score), member });
      }
      return 1;
    }),
    zcard: vi.fn(async () => state.pending.size),
    zrange: vi.fn(async () => []),
    hget: vi.fn(async (key: string, field: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      return state.claimed.get(workerId)?.get(field) ?? null;
    }),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      let workerMap = state.claimed.get(workerId);
      if (!workerMap) {
        workerMap = new Map();
        state.claimed.set(workerId, workerMap);
      }
      workerMap.set(field, value);
      return 1;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      const workerMap = state.claimed.get(workerId);
      if (workerMap?.delete(field)) return 1;
      return 0;
    }),
    del: vi.fn(async (key: string) => {
      if (state.heartbeats.delete(key)) return 1;
      return 0;
    }),
    sismember: vi.fn(async (key: string, member: string) => {
      if (key === 'orchestrator:queue:in-flight-items') {
        return state.inFlight.has(member) ? 1 : 0;
      }
      return 0;
    }),
    sadd: vi.fn(async (key: string, member: string) => {
      if (key === 'orchestrator:queue:in-flight-items') {
        const before = state.inFlight.size;
        state.inFlight.add(member);
        return state.inFlight.size > before ? 1 : 0;
      }
      return 0;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      sremSpy(key, member);
      if (key === 'orchestrator:queue:in-flight-items') {
        return state.inFlight.delete(member) ? 1 : 0;
      }
      return 0;
    }),
    hlen: vi.fn(async () => 0),
    scan: vi.fn(async () => ['0', []]),
    defineCommand: vi.fn(),

    // Mock Lua script: mirrors ENQUEUE_IF_ABSENT_SCRIPT exactly — SISMEMBER, then
    // SADD + ZADD, or return 0. Serves the atomicity contract as a synchronous check.
    enqueueIfAbsent: vi.fn(async (_pendingKey: string, inFlightKey: string, itemKey: string, priority: string, payload: string) => {
      if (state.inFlight.has(itemKey)) return 0;
      state.inFlight.add(itemKey);
      state.pending.set(itemKey, { score: Number(priority), member: payload });
      zaddSpy(_pendingKey, Number(priority), payload);
      return 1;
    }),

    // Mock CLAIM_SCRIPT: pop lowest-priority pending, move to claimed hash.
    claimItem: vi.fn(async (_pendingKey: string, claimedKey: string, heartbeatKey: string) => {
      if (state.pending.size === 0) return null;
      const sorted = [...state.pending.values()].sort((a, b) => a.score - b.score);
      const first = sorted[0]!;
      const parsed: SerializedQueueItem = JSON.parse(first.member);
      state.pending.delete(parsed.itemKey);
      const workerId = claimedKey.replace('orchestrator:queue:claimed:', '');
      let workerMap = state.claimed.get(workerId);
      if (!workerMap) {
        workerMap = new Map();
        state.claimed.set(workerId, workerMap);
      }
      workerMap.set(parsed.itemKey, first.member);
      state.heartbeats.add(heartbeatKey);
      return first.member;
    }),
  };

  // Chainable multi() that forwards to the underlying mocks.
  redis['multi'] = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    const queued: Promise<unknown>[] = [];
    const forward = (name: string) => (...args: unknown[]) => {
      const fn = redis[name] as (...a: unknown[]) => Promise<unknown>;
      queued.push(fn(...args));
      return chain;
    };
    for (const name of ['hdel', 'del', 'zadd', 'srem', 'sadd', 'hset']) {
      chain[name] = forward(name);
    }
    chain['exec'] = vi.fn(async () => {
      const results = await Promise.all(queued);
      return results.map((r) => [null, r] as [null, unknown]);
    });
    return chain;
  });

  return { redis, state, zaddSpy, sremSpy };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const sampleItem: QueueItem = {
  owner: 'test-org',
  repo: 'test-repo',
  issueNumber: 42,
  workflowName: 'speckit-feature',
  command: 'continue',
  priority: 1000,
  enqueuedAt: '2026-07-08T00:00:00Z',
  queueReason: 'resume',
};

describe('RedisQueueAdapter.enqueueIfAbsent', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('returns true on first enqueue and false on second for same itemKey (Lua atomicity)', async () => {
    const { redis } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    const first = await adapter.enqueueIfAbsent(sampleItem);
    const second = await adapter.enqueueIfAbsent(sampleItem);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('SISMEMBER == 1 after successful enqueueIfAbsent (in-flight invariant)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    await adapter.enqueueIfAbsent(sampleItem);

    const inFlight = await adapter.hasInFlight('test-org/test-repo#42');
    expect(inFlight).toBe(true);
    expect(state.inFlight.has('test-org/test-repo#42')).toBe(true);
    expect(state.pending.has('test-org/test-repo#42')).toBe(true);
  });

  it('full lifecycle enqueueIfAbsent → claim → complete removes from SET and claimed hash', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    await adapter.enqueueIfAbsent(sampleItem);
    const claimed = await adapter.claim('worker-1');
    expect(claimed).not.toBeNull();
    // Still in flight while claimed
    expect(state.inFlight.has('test-org/test-repo#42')).toBe(true);
    expect(state.claimed.get('worker-1')?.has('test-org/test-repo#42')).toBe(true);

    await adapter.complete('worker-1', claimed!);

    expect(state.inFlight.has('test-org/test-repo#42')).toBe(false);
    expect(state.claimed.get('worker-1')?.has('test-org/test-repo#42')).toBeFalsy();
  });

  it('enqueueIfAbsent → claim → release (retry) keeps item in SET (still in flight)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger, { maxRetries: 3 });

    await adapter.enqueueIfAbsent(sampleItem);
    const claimed = await adapter.claim('worker-1');
    await adapter.release('worker-1', claimed!);

    expect(state.inFlight.has('test-org/test-repo#42')).toBe(true);
    expect(state.pending.has('test-org/test-repo#42')).toBe(true);
  });

  it('enqueueIfAbsent → claim → release (dead-letter, attemptCount >= maxRetries) removes from SET', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger, { maxRetries: 1 });

    // First cycle: attemptCount becomes 1
    await adapter.enqueueIfAbsent(sampleItem);
    const claimed = await adapter.claim('worker-1');
    await adapter.release('worker-1', claimed!);
    // At this point attemptCount became 1 >= maxRetries=1 → dead-letter

    expect(state.inFlight.has('test-org/test-repo#42')).toBe(false);
    expect(state.deadLetter).toHaveLength(1);
  });

  it('orphan claim (dead worker) counts as in-flight — enqueueIfAbsent returns false until reclaim clears SET', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    // Seed an orphan claim by directly manipulating state
    state.inFlight.add('test-org/test-repo#42');
    const workerMap = new Map<string, string>();
    workerMap.set('test-org/test-repo#42', JSON.stringify({ ...sampleItem, attemptCount: 0, itemKey: 'test-org/test-repo#42' }));
    state.claimed.set('dead-worker', workerMap);

    const first = await adapter.enqueueIfAbsent(sampleItem);
    expect(first).toBe(false);

    // Simulate reclaim: remove claim + SET member
    state.claimed.get('dead-worker')!.delete('test-org/test-repo#42');
    state.inFlight.delete('test-org/test-repo#42');

    const second = await adapter.enqueueIfAbsent(sampleItem);
    expect(second).toBe(true);
  });

  it('Redis error → returns false and logs warn (fail-safe)', async () => {
    const { redis } = createMockRedisWithState();
    (redis['enqueueIfAbsent'] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Connection refused'),
    );
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    const result = await adapter.enqueueIfAbsent(sampleItem);

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        itemKey: 'test-org/test-repo#42',
      }),
      'Redis error in enqueueIfAbsent, dropping (fail-safe)',
    );
  });

  it('successful enqueueIfAbsent emits info log with itemKey + priority', async () => {
    const { redis } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    await adapter.enqueueIfAbsent(sampleItem);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'test-org',
        repo: 'test-repo',
        issue: 42,
        itemKey: 'test-org/test-repo#42',
      }),
      'Item enqueued to Redis sorted set (in-flight-checked)',
    );
  });

  it('rejected enqueueIfAbsent (already in flight) does NOT emit info log', async () => {
    const { redis } = createMockRedisWithState();
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    await adapter.enqueueIfAbsent(sampleItem);
    logger.info.mockClear();

    const second = await adapter.enqueueIfAbsent(sampleItem);

    expect(second).toBe(false);
    // The underlying primitive stays quiet — the caller layer owns the drop log.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('hasInFlight returns false and logs warn on Redis error (fail-safe)', async () => {
    const { redis } = createMockRedisWithState();
    (redis['sismember'] as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Connection refused'),
    );
    const adapter = new RedisQueueAdapter(redis as unknown as import('ioredis').Redis, logger);

    const result = await adapter.hasInFlight('test-org/test-repo#42');

    expect(result).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        itemKey: 'test-org/test-repo#42',
      }),
      'Redis error in hasInFlight',
    );
  });
});
