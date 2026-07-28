import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueItem, QueueManager, SerializedQueueItem } from '../../types/index.js';

/**
 * #1060 / SC-003 — cross-adapter parity for the `enqueue()` in-flight-SET
 * invariant. Parameterized across both adapters so a divergence in
 * drop-vs-accept behaviour or log-line shape produces a clear per-adapter
 * failure attribution.
 */

interface MockState {
  pending: Map<string, { score: number; member: string }>;
  claimed: Map<string, Map<string, string>>;
  inFlight: Set<string>;
  heartbeats: Set<string>;
}

function createMockRedisWithState() {
  const state: MockState = {
    pending: new Map(),
    claimed: new Map(),
    inFlight: new Set(),
    heartbeats: new Set(),
  };

  const redis: Record<string, unknown> = {
    zadd: vi.fn(async (key: string, score: number | string, member: string) => {
      if (key === 'orchestrator:queue:pending') {
        state.pending.set(member, { score: Number(score), member });
      }
      return 1;
    }),
    zcard: vi.fn(async () => state.pending.size),
    zrange: vi.fn(async (_key: string, start: number, stop: number) => {
      const arr = [...state.pending.values()].map((e) => e.member);
      const end = stop === -1 ? arr.length : stop + 1;
      return arr.slice(start, end);
    }),
    hget: vi.fn(async (key: string, field: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      return state.claimed.get(workerId)?.get(field) ?? null;
    }),
    hgetall: vi.fn(async () => ({})),
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
    hlen: vi.fn(async () => 0),
    del: vi.fn(async (key: string) => {
      if (state.heartbeats.delete(key)) return 1;
      return 0;
    }),
    exists: vi.fn(async () => 0),
    sismember: vi.fn(async (key: string, member: string) =>
      key === 'orchestrator:queue:in-flight-items' && state.inFlight.has(member) ? 1 : 0,
    ),
    sadd: vi.fn(async (key: string, member: string) => {
      if (key === 'orchestrator:queue:in-flight-items') {
        const before = state.inFlight.size;
        state.inFlight.add(member);
        return state.inFlight.size > before ? 1 : 0;
      }
      return 0;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      if (key === 'orchestrator:queue:in-flight-items') {
        return state.inFlight.delete(member) ? 1 : 0;
      }
      return 0;
    }),
    scan: vi.fn(async () => ['0', []]),
    defineCommand: vi.fn(),
    // #1060 PR #1065 review findings 5+6 — `enqueue()` and
    // `enqueueIfAbsent()` share the single `enqueueIfAbsent` Lua
    // command. Byte-shape asserted separately in
    // `redis-queue-adapter.script-wiring.test.ts`.
    enqueueIfAbsent: vi.fn(async (
      _pending: string,
      _inFlight: string,
      itemKey: string,
      priority: string,
      payload: string,
    ) => {
      if (state.inFlight.has(itemKey)) return 0;
      state.inFlight.add(itemKey);
      state.pending.set(payload, { score: Number(priority), member: payload });
      return 1;
    }),
    claimItem: vi.fn(async (
      _pending: string,
      claimedKey: string,
      heartbeatKey: string,
      _ttl: number,
      claimedAt: string,
    ) => {
      if (state.pending.size === 0) return null;
      const sorted = [...state.pending.values()].sort((a, b) => a.score - b.score);
      const first = sorted[0]!;
      const parsed: SerializedQueueItem = JSON.parse(first.member);
      parsed.claimedAt = claimedAt;
      const reserialized = JSON.stringify(parsed);
      state.pending.delete(first.member);
      const workerId = claimedKey.replace('orchestrator:queue:claimed:', '');
      let workerMap = state.claimed.get(workerId);
      if (!workerMap) {
        workerMap = new Map();
        state.claimed.set(workerId, workerMap);
      }
      workerMap.set(parsed.itemKey, reserialized);
      state.heartbeats.add(heartbeatKey);
      return reserialized;
    }),
  };

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

  return redis;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: overrides.owner ?? 'generacy-ai',
    repo: overrides.repo ?? 'generacy',
    issueNumber: overrides.issueNumber ?? 1060,
    workflowName: overrides.workflowName ?? 'speckit-feature',
    command: overrides.command ?? 'implement',
    priority: overrides.priority ?? 1000,
    enqueuedAt: overrides.enqueuedAt ?? new Date().toISOString(),
    metadata: overrides.metadata,
    queueReason: overrides.queueReason ?? 'new',
  };
}

interface AdapterHarness {
  name: string;
  make(logger: ReturnType<typeof createLogger>): QueueManager;
}

const HARNESSES: AdapterHarness[] = [
  {
    name: 'in-memory',
    make: (logger) =>
      new InMemoryQueueAdapter(logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
      }),
  },
  {
    name: 'redis',
    make: (logger) =>
      new RedisQueueAdapter(createMockRedisWithState() as unknown as import('ioredis').Redis, logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: 15_000,
      }),
  },
];

describe.each(HARNESSES)('$name adapter — enqueue() FR-007 parity (#1060 / SC-003)', ({ make }) => {
  let logger: ReturnType<typeof createLogger>;
  let adapter: QueueManager;

  beforeEach(() => {
    logger = createLogger();
    adapter = make(logger);
  });

  it('enqueue returns true on first insert', async () => {
    expect(await adapter.enqueue(makeItem({ issueNumber: 1060 }))).toBe(true);
  });

  it('enqueue returns false on duplicate itemKey (same call twice)', async () => {
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const second = await adapter.enqueue(makeItem({
      issueNumber: 1060,
      enqueuedAt: new Date(Date.now() + 1000).toISOString(),
    }));
    expect(second).toBe(false);
    expect(await adapter.getQueueDepth()).toBe(1);
  });

  it('enqueue keeps itemKey in-flight across claim', async () => {
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const claimed = await adapter.claim('worker-A');
    expect(claimed).not.toBeNull();
    expect(await adapter.hasInFlight('generacy-ai/generacy#1060')).toBe(true);
  });

  it('release retry then complete clears in-flight only after complete', async () => {
    const itemKey = 'generacy-ai/generacy#1060';
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const claimed = await adapter.claim('worker-A');
    expect(claimed).not.toBeNull();

    await adapter.release('worker-A', claimed!);
    expect(await adapter.hasInFlight(itemKey)).toBe(true);

    const reclaimed = await adapter.claim('worker-B');
    expect(reclaimed).not.toBeNull();
    await adapter.complete('worker-B', reclaimed!);
    expect(await adapter.hasInFlight(itemKey)).toBe(false);
  });

  it('drop log carries { itemKey, source: "enqueue", reason: "in-flight" } — shape parity across adapters', async () => {
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    await adapter.enqueue(makeItem({
      issueNumber: 1060,
      enqueuedAt: new Date(Date.now() + 1000).toISOString(),
    }));

    const dropCall = logger.info.mock.calls.find(
      (c) => (c[0] as Record<string, unknown> | undefined)?.source === 'enqueue',
    );
    expect(dropCall, 'expected an info-level drop log with source=enqueue').toBeDefined();
    expect(dropCall![0]).toMatchObject({
      itemKey: 'generacy-ai/generacy#1060',
      source: 'enqueue',
      reason: 'in-flight',
    });
    expect(dropCall![1]).toBe('Dropping enqueue (item already in flight)');
  });

  it('cross-verb dedupe: enqueue then enqueueIfAbsent returns false for same key', async () => {
    expect(await adapter.enqueue(makeItem({ issueNumber: 1060 }))).toBe(true);
    expect(
      await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1060, queueReason: 'resume' })),
    ).toBe(false);
  });

  it('cross-verb dedupe (inverse): enqueueIfAbsent then enqueue returns false for same key', async () => {
    expect(
      await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1060, queueReason: 'resume' })),
    ).toBe(true);
    expect(await adapter.enqueue(makeItem({ issueNumber: 1060 }))).toBe(false);
  });
});
