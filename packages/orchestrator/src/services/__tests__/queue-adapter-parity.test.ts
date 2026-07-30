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
    sscan: vi.fn(async (key: string) => {
      // Simplified: return all matching members in one iteration.
      if (key === 'orchestrator:queue:in-flight-items') {
        return ['0', [...state.inFlight]];
      }
      return ['0', []];
    }),
    hkeys: vi.fn(async (key: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      const workerMap = state.claimed.get(workerId);
      if (!workerMap) return [];
      return [...workerMap.keys()];
    }),
    scan: vi.fn(async (_cursor: string, ..._rest: unknown[]) => {
      // #1058: caller may pass MATCH/COUNT; enumerate live claim-hash keys.
      const keys: string[] = [];
      for (const workerId of state.claimed.keys()) {
        if (state.claimed.get(workerId)!.size > 0) {
          keys.push(`orchestrator:queue:claimed:${workerId}`);
        }
      }
      return ['0', keys];
    }),
    reconcileInFlightItem: vi.fn(async (_inFlightKey: string, itemKey: string) => {
      if (!state.inFlight.has(itemKey)) return 0;
      state.inFlight.delete(itemKey);
      return 1;
    }),
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
    // #1069 mock: mirrors REQUEUE_FOR_RESUME_SCRIPT — [code, attemptCount].
    // {0, -1} = claim already cleared (reaper race); {1, N} = re-pended at
    // resume priority with attemptCount preserved verbatim. Never touches
    // the in-flight SET (item stays in flight; only its claim moves back
    // to pending).
    requeueForResumeItem: vi.fn(async (
      _pendingKey: string,
      claimedKey: string,
      heartbeatKey: string,
      itemKey: string,
      resumePriority: string,
      baseJson: string,
    ) => {
      const workerId = claimedKey.replace('orchestrator:queue:claimed:', '');
      const claimed = state.claimed.get(workerId)?.get(itemKey);
      if (!claimed) {
        state.heartbeats.delete(heartbeatKey);
        return [0, -1];
      }
      const parsed: SerializedQueueItem = JSON.parse(claimed);
      const base: SerializedQueueItem = JSON.parse(baseJson);
      base.queueReason = 'resume';
      base.priority = Number(resumePriority);
      base.attemptCount = parsed.attemptCount;
      base.itemKey = itemKey;
      base.claimedAt = undefined;
      const repayload = JSON.stringify(base);
      state.claimed.get(workerId)?.delete(itemKey);
      state.heartbeats.delete(heartbeatKey);
      state.pending.set(repayload, { score: Number(resumePriority), member: repayload });
      return [1, parsed.attemptCount];
    }),
    // #1069 mock: mirrors RELEASE_SCRIPT — [code, attemptCount].
    // {0, -1} = reaper race no-op; {1, N} = retry branch (claimed→pending,
    // in-flight preserved); {2, N} = dead-letter branch (claimed→dead-letter,
    // SREM in-flight). The dead-letter branch's SREM is load-bearing for
    // the FR-007 invariant that this test's "release retry then complete
    // clears in-flight only after complete" assertion depends on — a stub
    // that dropped in-flight membership on the retry branch would pass
    // the immediate assertion and silently break the one this test exists
    // for.
    releaseItem: vi.fn(async (
      _pendingKey: string,
      claimedKey: string,
      heartbeatKey: string,
      _deadLetterKey: string,
      _inFlightKey: string,
      itemKey: string,
      retryPriority: string,
      baseJson: string,
      maxRetriesStr: string,
      _nowMsStr: string,
    ) => {
      const workerId = claimedKey.replace('orchestrator:queue:claimed:', '');
      const claimed = state.claimed.get(workerId)?.get(itemKey);
      if (!claimed) {
        state.heartbeats.delete(heartbeatKey);
        return [0, -1];
      }
      const parsed: SerializedQueueItem = JSON.parse(claimed);
      const attemptCount = (parsed.attemptCount ?? 0) + 1;
      const maxRetries = Number(maxRetriesStr);
      const base: SerializedQueueItem = JSON.parse(baseJson);
      base.attemptCount = attemptCount;
      base.itemKey = itemKey;
      base.claimedAt = undefined;

      if (attemptCount >= maxRetries) {
        state.claimed.get(workerId)?.delete(itemKey);
        state.heartbeats.delete(heartbeatKey);
        state.inFlight.delete(itemKey);
        return [2, attemptCount];
      }

      base.queueReason = 'retry';
      base.priority = Number(retryPriority);
      const repayload = JSON.stringify(base);
      state.claimed.get(workerId)?.delete(itemKey);
      state.heartbeats.delete(heartbeatKey);
      state.pending.set(repayload, { score: Number(retryPriority), member: repayload });
      return [1, attemptCount];
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

describe.each(HARNESSES)('$name adapter — reconcileInFlight parity (#1058)', ({ make }) => {
  let logger: ReturnType<typeof createLogger>;
  let adapter: QueueManager;

  beforeEach(() => {
    logger = createLogger();
    adapter = make(logger);
  });

  it('exists and returns a ReconcileReport shape', async () => {
    const report = await adapter.reconcileInFlight();
    expect(report).toEqual(
      expect.objectContaining({
        scanned: expect.any(Number),
        reconciled: expect.any(Number),
        skippedAlreadyGone: expect.any(Number),
        trackedFirstSeen: expect.any(Number),
      }),
    );
  });

  it('healthy-state cycle (enqueue → claim → complete) produces zero reconciled', async () => {
    await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1058 }));
    const claimed = await adapter.claim('worker-parity');
    expect(claimed).not.toBeNull();
    await adapter.complete('worker-parity', claimed!);

    const report = await adapter.reconcileInFlight();
    expect(report.reconciled).toBe(0);
    expect(report.skippedAlreadyGone).toBe(0);
    // Note: `scanned` differs by adapter (Redis reports SSCAN'd count,
    // in-memory reports set size at call time — both truthful). Wedge-repair
    // (SC-001) is Redis-only per contract; not asserted here.
  });
});
