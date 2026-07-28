import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1060 — regression suite for the `RedisQueueAdapter.enqueue()` in-flight-SET
 * invariant restoration. Uses the same stateful-mock harness pattern as
 * `redis-queue-adapter.orphan-reclaim.test.ts` (ZSET keyed by full member
 * string, not by itemKey — mirrors real Redis semantics so the double-enqueue
 * hazard is not structurally hidden).
 *
 * The new `enqueueItem` Lua script (`ENQUEUE_SCRIPT`) is byte-identical to
 * `ENQUEUE_IF_ABSENT_SCRIPT`, so the mock stub for both simulates the same
 * atomic `SISMEMBER` → conditional `SADD` + `ZADD`.
 */

interface MockState {
  pending: Map<string, { score: number; member: string }>;
  claimed: Map<string, Map<string, string>>;
  inFlight: Set<string>;
  heartbeats: Set<string>;
  dedup: Map<string, Record<string, string>>;
}

function pendingByItemKey(
  state: MockState,
  itemKey: string,
): { score: number; member: string }[] {
  const out: { score: number; member: string }[] = [];
  for (const entry of state.pending.values()) {
    try {
      const parsed: SerializedQueueItem = JSON.parse(entry.member);
      if (parsed.itemKey === itemKey) out.push(entry);
    } catch {
      /* ignore */
    }
  }
  return out;
}

function claimedByItemKey(state: MockState, itemKey: string): { workerId: string; payload: string }[] {
  const out: { workerId: string; payload: string }[] = [];
  for (const [workerId, workerMap] of state.claimed) {
    const payload = workerMap.get(itemKey);
    if (payload) out.push({ workerId, payload });
  }
  return out;
}

function createMockRedisWithState() {
  const state: MockState = {
    pending: new Map(),
    claimed: new Map(),
    inFlight: new Set(),
    heartbeats: new Set(),
    dedup: new Map(),
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
    hgetall: vi.fn(async (key: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      const workerMap = state.claimed.get(workerId);
      if (!workerMap) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of workerMap) out[k] = v;
      return out;
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
    hlen: vi.fn(async (key: string) => {
      const workerId = key.replace('orchestrator:queue:claimed:', '');
      return state.claimed.get(workerId)?.size ?? 0;
    }),
    del: vi.fn(async (key: string) => {
      if (key.startsWith('orchestrator:queue:claimed:')) {
        const workerId = key.replace('orchestrator:queue:claimed:', '');
        if (state.claimed.delete(workerId)) return 1;
        return 0;
      }
      if (state.heartbeats.delete(key)) return 1;
      return 0;
    }),
    exists: vi.fn(async (key: string) => (state.heartbeats.has(key) ? 1 : 0)),
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
      if (key === 'orchestrator:queue:in-flight-items') {
        return state.inFlight.delete(member) ? 1 : 0;
      }
      return 0;
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      const keys: string[] = [];
      for (const workerId of state.claimed.keys()) {
        const key = `orchestrator:queue:claimed:${workerId}`;
        if (key.startsWith(prefix)) keys.push(key);
      }
      return ['0', keys];
    }),
    defineCommand: vi.fn(),

    // Mock ENQUEUE_SCRIPT — byte-identical to ENQUEUE_IF_ABSENT_SCRIPT.
    enqueueItem: vi.fn(async (
      _pendingKey: string,
      _inFlightKey: string,
      _dedupKey: string,
      itemKey: string,
      priority: string,
      payload: string,
    ) => {
      if (state.inFlight.has(itemKey)) return 0;
      state.inFlight.add(itemKey);
      state.pending.set(payload, { score: Number(priority), member: payload });
      return 1;
    }),

    // Mock ENQUEUE_IF_ABSENT_SCRIPT — same atomic semantics.
    enqueueIfAbsent: vi.fn(async (
      _pendingKey: string,
      _inFlightKey: string,
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
      _pendingKey: string,
      claimedKey: string,
      heartbeatKey: string,
      _ttlSeconds: number,
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

    reclaimOrphan: vi.fn(async (
      claimedKey: string,
      heartbeatKey: string,
      pendingKey: string,
      itemKey: string,
      ageMsStr: string,
      graceWindowMsStr: string,
      resumePriorityStr: string,
      reclaimItemJSON: string,
    ) => {
      const workerId = claimedKey.replace('orchestrator:queue:claimed:', '');
      const workerMap = state.claimed.get(workerId);
      const claimedPayload = workerMap?.get(itemKey);
      if (!claimedPayload) return 0;
      if (state.heartbeats.has(heartbeatKey)) return 2;
      if (Number(ageMsStr) < Number(graceWindowMsStr)) return 3;
      workerMap!.delete(itemKey);
      if (workerMap!.size === 0) state.claimed.delete(workerId);
      if (pendingKey === 'orchestrator:queue:pending') {
        state.pending.set(reclaimItemJSON, {
          score: Number(resumePriorityStr),
          member: reclaimItemJSON,
        });
      }
      return 1;
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

  return { redis, state };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

function makeAdapter(redis: unknown, logger: ReturnType<typeof createLogger>) {
  return new RedisQueueAdapter(redis as import('ioredis').Redis, logger, {
    maxRetries: 3,
    maxRunDurationMs: 1_800_000,
    heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
  });
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

describe('RedisQueueAdapter.enqueue — #1060 in-flight-SET invariant', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('(a) enqueue({ itemKey }) → SISMEMBER IN_FLIGHT_KEY itemKey === 1 (SC-002)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    const item = makeItem({ issueNumber: 1060 });
    const enqueued = await adapter.enqueue(item);

    expect(enqueued).toBe(true);
    expect(state.inFlight.has('generacy-ai/generacy#1060')).toBe(true);
    expect(await adapter.hasInFlight('generacy-ai/generacy#1060')).toBe(true);
  });

  it('(b) enqueue → enqueue same key → second returns false, no double-add', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    const item = makeItem({ issueNumber: 1060 });
    const first = await adapter.enqueue(item);
    // Force a different member string on the second call so the ZSET would
    // add a distinct member if the SISMEMBER guard were removed.
    const second = await adapter.enqueue({
      ...item,
      enqueuedAt: new Date(Date.parse(item.enqueuedAt) + 1000).toISOString(),
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(state.pending.size).toBe(1);
    expect(state.inFlight.size).toBe(1);
    expect(pendingByItemKey(state, 'generacy-ai/generacy#1060')).toHaveLength(1);
  });

  it('(c) enqueue → claim → SISMEMBER IN_FLIGHT_KEY itemKey === 1 (CLAIM_SCRIPT preserves)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    const item = makeItem({ issueNumber: 1060 });
    await adapter.enqueue(item);
    const claimed = await adapter.claim('worker-A');

    expect(claimed).not.toBeNull();
    expect(claimed!.issueNumber).toBe(1060);
    // Post-claim: pending is empty, but in-flight SET still holds the key.
    expect(state.pending.size).toBe(0);
    expect(state.inFlight.has('generacy-ai/generacy#1060')).toBe(true);
  });

  it('(d) enqueue → claim → release-retry → reclaim-orphan → complete: invariant in-flight == pending ∪ claimed at every step (SC-004)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    const itemKey = 'generacy-ai/generacy#1060';
    const assertInvariant = (label: string) => {
      const claimedKeys = new Set<string>();
      for (const workerMap of state.claimed.values()) {
        for (const k of workerMap.keys()) claimedKeys.add(k);
      }
      const pendingKeys = new Set<string>();
      for (const entry of state.pending.values()) {
        const parsed: SerializedQueueItem = JSON.parse(entry.member);
        pendingKeys.add(parsed.itemKey);
      }
      const union = new Set([...pendingKeys, ...claimedKeys]);
      // in-flight SET == pending ∪ claimed
      expect(
        [...state.inFlight].sort(),
        `${label}: in-flight vs pending∪claimed diverged`,
      ).toEqual([...union].sort());
    };

    // Step 1: enqueue
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    assertInvariant('after enqueue');

    // Step 2: claim
    const claimed = await adapter.claim('worker-A');
    expect(claimed).not.toBeNull();
    assertInvariant('after claim');

    // Step 3: release (retry path — attempt count 1 < maxRetries=3)
    await adapter.release('worker-A', claimed!);
    assertInvariant('after release-retry');

    // Step 4: re-claim then simulate orphan — worker dies (heartbeat gone),
    // then reap. We simulate by claiming, deleting the heartbeat, then
    // reaping with age > grace window.
    const reclaimed = await adapter.claim('worker-B');
    expect(reclaimed).not.toBeNull();
    assertInvariant('after re-claim');

    // Make heartbeat absent + set claimedAt far in the past so grace window
    // is exceeded.
    state.heartbeats.clear();
    const claimedMap = state.claimed.get('worker-B')!;
    const payload: SerializedQueueItem = JSON.parse(claimedMap.get(itemKey)!);
    payload.claimedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    claimedMap.set(itemKey, JSON.stringify(payload));

    await adapter.reapOrphanClaims();
    assertInvariant('after reap-orphan');

    // Step 5: claim again then complete
    const finalClaim = await adapter.claim('worker-C');
    expect(finalClaim).not.toBeNull();
    assertInvariant('after final claim');

    await adapter.complete('worker-C', finalClaim!);
    // After complete, in-flight SET should not contain the itemKey.
    expect(state.inFlight.has(itemKey)).toBe(false);
    assertInvariant('after complete');
  });

  it('drop path emits emitDropLog line with { itemKey, source: "enqueue", reason: "in-flight" } fields', async () => {
    const { redis } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    const item = makeItem({ issueNumber: 1060 });
    await adapter.enqueue(item);
    await adapter.enqueue({
      ...item,
      enqueuedAt: new Date(Date.parse(item.enqueuedAt) + 1000).toISOString(),
    });

    // Second enqueue must drop; log payload carries the FR-005 shape.
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

  describe('#1060 observed incident regression', () => {
    it('FR-008 wedge: enqueue(#N) → claim(worker-A, #N) → concurrent enqueueIfAbsent(#N) from a monitor code path → second dropped, ZCARD pending === 0, exactly one claim exists', async () => {
      const { redis, state } = createMockRedisWithState();
      const adapter = makeAdapter(redis, logger);

      const itemKey = 'generacy-ai/generacy#1053';
      const item = makeItem({ issueNumber: 1053, queueReason: 'new' });

      // Step 1: process-label path enqueues via enqueue()
      const enqueued = await adapter.enqueue(item);
      expect(enqueued).toBe(true);
      expect(state.inFlight.has(itemKey)).toBe(true);

      // Step 2: worker claims it
      const claimed = await adapter.claim('worker-A');
      expect(claimed).not.toBeNull();
      expect(claimed!.issueNumber).toBe(1053);

      // Step 3: a monitor code path re-fires enqueueIfAbsent for the same
      // issue while it is still claimed by worker-A.
      const monitorItem = makeItem({
        issueNumber: 1053,
        queueReason: 'resume',
        enqueuedAt: new Date().toISOString(),
      });
      const monitorEnqueued = await adapter.enqueueIfAbsent(monitorItem);

      // Assertion: dropped. No second pending member. Exactly one claim.
      expect(monitorEnqueued).toBe(false);
      expect(await adapter.getQueueDepth()).toBe(0);
      expect(pendingByItemKey(state, itemKey)).toHaveLength(0);
      expect(claimedByItemKey(state, itemKey)).toHaveLength(1);
      // The in-flight SET still marks it in-flight.
      expect(state.inFlight.has(itemKey)).toBe(true);
    });

    it('FR-008 wedge (inverse): enqueueIfAbsent path first, then subsequent enqueue() is dropped — cross-verb dedupe holds both directions', async () => {
      const { redis, state } = createMockRedisWithState();
      const adapter = makeAdapter(redis, logger);

      const itemKey = 'generacy-ai/generacy#1060';
      const monitorFirst = await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1060, queueReason: 'resume' }));
      expect(monitorFirst).toBe(true);

      const processLabel = await adapter.enqueue(makeItem({
        issueNumber: 1060,
        queueReason: 'new',
        enqueuedAt: new Date(Date.now() + 1_000).toISOString(),
      }));

      expect(processLabel).toBe(false);
      expect(state.pending.size).toBe(1);
      expect(pendingByItemKey(state, itemKey)).toHaveLength(1);
    });
  });
});
