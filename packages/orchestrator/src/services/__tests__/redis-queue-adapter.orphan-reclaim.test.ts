import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1054 / US4 / FR-009 regression suite — reproduces the exact wedge shape
 * from `generacy-ai/generacy#1051` (worker died without unwinding; claim
 * hash + in-flight SET member survive with no heartbeat).
 *
 * Reuses the stateful mock pattern from
 * `redis-queue-adapter.enqueueIfAbsent.test.ts:16-125`, extended with
 * `EXISTS`/`SCAN`/`HGETALL`/`HLEN`/`DEL`/`SREM`/`ZADD` behaviour and a
 * `defineCommand('reclaimOrphan', ...)` Lua stub simulating the return-code
 * contract in `contracts/reclaim-orphan-script.md`.
 *
 * #1054 finding 2 — pending is keyed by the FULL MEMBER STRING (mirrors real
 * Redis ZSET semantics: two distinct payloads for the same itemKey ARE two
 * ZSET members and BOTH claim a pollOnce slot). The earlier upsert-by-itemKey
 * mock structurally hid the double-enqueue hazard that would have been caused
 * by an errant SREM in the reclaim script.
 */

interface MockState {
  /**
   * Pending ZSET: keyed by the full serialized member string, mirroring real
   * Redis ZADD semantics. Duplicate itemKeys with different payloads land as
   * two distinct entries — a `pollOnce` in production would claim each one.
   */
  pending: Map<string, { score: number; member: string }>;      // member string → entry
  claimed: Map<string, Map<string, string>>;                    // workerId → itemKey → serialized
  inFlight: Set<string>;                                        // itemKey members
  heartbeats: Set<string>;                                      // heartbeat keys (present = alive)
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
      // Ignore
    }
  }
  return out;
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
        // Real Redis ZADD upserts by MEMBER (byte-for-byte string), not by
        // any inner field. Two distinct payloads for the same itemKey are
        // two distinct members. #1054 finding 2 relies on this shape.
        state.pending.set(member, { score: Number(score), member });
      }
      return 1;
    }),
    zcard: vi.fn(async () => state.pending.size),
    zrange: vi.fn(async () => []),
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
    exists: vi.fn(async (key: string) => {
      return state.heartbeats.has(key) ? 1 : 0;
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
      if (key === 'orchestrator:queue:in-flight-items') {
        return state.inFlight.delete(member) ? 1 : 0;
      }
      return 0;
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      // Simplified: return all matching keys in one iteration (COUNT is advisory).
      const prefix = pattern.replace(/\*$/, '');
      const keys: string[] = [];
      for (const workerId of state.claimed.keys()) {
        const key = `orchestrator:queue:claimed:${workerId}`;
        if (key.startsWith(prefix)) keys.push(key);
      }
      return ['0', keys];
    }),
    defineCommand: vi.fn(),

    // Mock ENQUEUE_IF_ABSENT_SCRIPT
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

    // Mock CLAIM_SCRIPT — stamps claimedAt into the payload (finding 3).
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

    /**
     * Mock RECLAIM_ORPHAN_SCRIPT — mirrors the Lua contract return codes
     * from contracts/reclaim-orphan-script.md.
     *
     * #1054 finding 1: does NOT SREM the in-flight SET (reclaimed item is
     * legitimately still in flight).
     */
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

      const ageMs = Number(ageMsStr);
      const graceWindowMs = Number(graceWindowMsStr);
      if (ageMs < graceWindowMs) return 3;

      workerMap!.delete(itemKey);
      if (workerMap!.size === 0) state.claimed.delete(workerId);
      // NOTE: no SREM on in-flight (finding 1). Reclaimed items stay in the
      // in-flight SET — they've moved from claimed back to pending.
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
const GRACE_WINDOW_MS = 2 * HEARTBEAT_CHECK_INTERVAL_MS;

function makeAdapter(
  redis: unknown,
  logger: ReturnType<typeof createLogger>,
  overrides: Partial<{
    maxRetries: number;
    maxRunDurationMs: number;
    heartbeatCheckIntervalMs: number;
  }> = {},
) {
  return new RedisQueueAdapter(redis as import('ioredis').Redis, logger, {
    maxRetries: overrides.maxRetries ?? 3,
    maxRunDurationMs: overrides.maxRunDurationMs ?? 1_800_000,
    heartbeatCheckIntervalMs:
      overrides.heartbeatCheckIntervalMs ?? HEARTBEAT_CHECK_INTERVAL_MS,
  });
}

const ORPHANED_ITEM_KEY = 'generacy-ai/generacy#1051';
const ORPHANED_WORKER_ID = '177e2263-5ea7-4e84-83a5-eec6b46a7c12';

function seedOrphanedClaim(
  state: ReturnType<typeof createMockRedisWithState>['state'],
  overrides: Partial<{
    workerId: string;
    itemKey: string;
    enqueuedAt: string;
    attemptCount: number;
    metadata: Record<string, unknown>;
    heartbeatAlive: boolean;
  }> = {},
): SerializedQueueItem {
  const workerId = overrides.workerId ?? ORPHANED_WORKER_ID;
  const itemKey = overrides.itemKey ?? ORPHANED_ITEM_KEY;
  const enqueuedAt = overrides.enqueuedAt ?? new Date(Date.now() - 2 * GRACE_WINDOW_MS).toISOString();
  const attemptCount = overrides.attemptCount ?? 0;
  const metadata = overrides.metadata ?? { prNumber: 1052, reviewThreadIds: [3660221572, 3660221578] };

  const payload: SerializedQueueItem = {
    owner: 'generacy-ai',
    repo: 'generacy',
    issueNumber: 1051,
    workflowName: 'speckit-feature',
    command: 'address-pr-feedback',
    priority: 0,
    queueReason: 'resume',
    enqueuedAt,
    attemptCount,
    itemKey,
    metadata,
  };

  state.inFlight.add(itemKey);
  const workerMap = new Map<string, string>();
  workerMap.set(itemKey, JSON.stringify(payload));
  state.claimed.set(workerId, workerMap);
  if (overrides.heartbeatAlive) {
    state.heartbeats.add(`orchestrator:worker:${workerId}:heartbeat`);
  }
  return payload;
}

describe('RedisQueueAdapter.reapOrphanClaims — #1054 / US4 / FR-009 regression', () => {
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger();
  });

  it('FR-001 / SC-001 / US4: orphaned claim (no heartbeat) reclaimed → claim gone, IN-FLIGHT PRESERVED, item re-pending with resume, attemptCount preserved, reclaimCount++', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state);
    // Sanity: matches the #1051 wedge state.
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    expect(state.claimed.get(ORPHANED_WORKER_ID)?.get(ORPHANED_ITEM_KEY)).toBeDefined();
    expect(state.heartbeats.size).toBe(0);

    const report = await adapter.reapOrphanClaims();

    // (a) Claim hash field is gone and (b) claim key was cleaned up.
    expect(state.claimed.get(ORPHANED_WORKER_ID)?.get(ORPHANED_ITEM_KEY)).toBeUndefined();
    expect(state.claimed.has(ORPHANED_WORKER_ID)).toBe(false);

    // (c) #1054 finding 1: itemKey STAYS in the in-flight SET (reclaimed item
    // is legitimately still in flight — moved from claimed back to pending).
    // The item is now in pending. `in-flight = pending ∪ claimed` invariant
    // is preserved by leaving it in the SET.
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    const pendingEntries = pendingByItemKey(state, ORPHANED_ITEM_KEY);
    expect(pendingEntries).toHaveLength(1);

    // Pending payload preserves enqueuedAt + metadata + attemptCount, bumps
    // reclaimCount, queueReason='resume', priority=0.
    const pendingEntry = pendingEntries[0]!;
    const parsed: SerializedQueueItem = JSON.parse(pendingEntry.member);
    expect(parsed.queueReason).toBe('resume');
    // Resume tier: getPriorityScore('resume') is 0.{timestamp} (< 1).
    expect(parsed.priority).toBeGreaterThanOrEqual(0);
    expect(parsed.priority).toBeLessThan(1);
    // #1054 finding 9: attemptCount is preserved (reaper does not bump the
    // dead-letter gate's counter). reclaimCount bumps instead.
    expect(parsed.attemptCount).toBe(0);
    expect(parsed.reclaimCount).toBe(1);
    expect(parsed.metadata).toEqual({ prNumber: 1052, reviewThreadIds: [3660221572, 3660221578] });
    expect(parsed.enqueuedAt).toBeDefined();

    // (d) The invariant is now: item is in pending AND in the in-flight SET,
    // so a subsequent enqueueIfAbsent for the same itemKey returns 0
    // (correctly — the item is already queued). This is the desired shape:
    // the SET tracks "somewhere in the pipeline" (pending ∪ claimed).
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);

    // Report shape.
    expect(report.scanned).toBe(1);
    expect(report.reclaimed).toHaveLength(1);
    expect(report.skippedRaceReappeared).toBe(0);
    expect(report.skippedGraceWindow).toBe(0);
  });

  it('#1054 finding 1 regression: reclaim must NOT SREM the in-flight SET (otherwise a subsequent monitor enqueue would land a second ZSET member for the same itemKey — double-enqueue hole)', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state);

    await adapter.reapOrphanClaims();

    // Immediately after reclaim, the item is in pending AND in the in-flight SET.
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    expect(pendingByItemKey(state, ORPHANED_ITEM_KEY)).toHaveLength(1);

    // Simulate the exact incident scenario: 5 min later a monitor cycle
    // fires enqueueIfAbsent for the same issue.
    const monitorItem: QueueItem = {
      owner: 'generacy-ai',
      repo: 'generacy',
      issueNumber: 1051,
      workflowName: 'speckit-feature',
      command: 'address-pr-feedback',
      priority: 1000,
      enqueuedAt: new Date().toISOString(),
      queueReason: 'resume',
    };

    const enqueued = await adapter.enqueueIfAbsent(monitorItem);

    // Because in-flight was NOT cleared by the reclaim, the second enqueue
    // is (correctly) dropped as a duplicate. Only ONE pending ZSET member
    // exists — no double-enqueue. If the SREM were reintroduced, this test
    // would fail with `pendingByItemKey(...).length === 2`.
    expect(enqueued).toBe(false);
    expect(pendingByItemKey(state, ORPHANED_ITEM_KEY)).toHaveLength(1);
  });

  it('US2 / SC-002: live heartbeat (still alive) survives sweep — no reclaim, no FR-008 warn', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state, { heartbeatAlive: true });
    const claimedBefore = new Map(state.claimed.get(ORPHANED_WORKER_ID)!);

    const report = await adapter.reapOrphanClaims();

    // Claim hash unchanged.
    expect(state.claimed.get(ORPHANED_WORKER_ID)?.get(ORPHANED_ITEM_KEY)).toBe(
      claimedBefore.get(ORPHANED_ITEM_KEY),
    );
    // itemKey still in in-flight SET.
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    // No re-enqueue.
    expect(pendingByItemKey(state, ORPHANED_ITEM_KEY)).toHaveLength(0);
    // No FR-008 warn emitted.
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan-claim-reclaimed' }),
      expect.any(String),
    );

    // Scanned count reflects the outer HGETALL total even though the
    // fast-path skip fired.
    expect(report.reclaimed).toHaveLength(0);
    expect(report.skippedRaceReappeared).toBe(0);
  });

  it('FR-005 / US2: heartbeat absent but within grace window → skippedGraceWindow, no mutation', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    // enqueuedAt very recent — inside `2 × heartbeatCheckIntervalMs` grace.
    const recentEnqueuedAt = new Date(Date.now() - 1_000).toISOString();
    seedOrphanedClaim(state, { enqueuedAt: recentEnqueuedAt });

    const report = await adapter.reapOrphanClaims();

    expect(report.skippedGraceWindow).toBe(1);
    expect(report.reclaimed).toHaveLength(0);
    // No mutation.
    expect(state.claimed.get(ORPHANED_WORKER_ID)?.get(ORPHANED_ITEM_KEY)).toBeDefined();
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    expect(pendingByItemKey(state, ORPHANED_ITEM_KEY)).toHaveLength(0);
  });

  it('US2 race abort: heartbeat re-appears server-side between outer EXISTS and Lua → skippedRaceReappeared, no mutation, no FR-008 warn', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state);

    // Force the Lua stub to return `2` (heartbeat re-appeared server-side)
    // even though the outer EXISTS said 0. Simulates the microsecond race.
    (redis.reclaimOrphan as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => 2,
    );

    const report = await adapter.reapOrphanClaims();

    expect(report.skippedRaceReappeared).toBe(1);
    expect(report.reclaimed).toHaveLength(0);
    // No mutation.
    expect(state.claimed.get(ORPHANED_WORKER_ID)?.get(ORPHANED_ITEM_KEY)).toBeDefined();
    expect(state.inFlight.has(ORPHANED_ITEM_KEY)).toBe(true);
    expect(pendingByItemKey(state, ORPHANED_ITEM_KEY)).toHaveLength(0);
    // No FR-008 warn.
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'orphan-claim-reclaimed' }),
      expect.any(String),
    );
  });

  it('AD-6 / FR-002 / #1054 finding 9: reaper preserves attemptCount (dead-letter gate) and bumps reclaimCount (diagnostic) — never dead-lettered by the reaper', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    // Source item already has attemptCount = 7 (well over any default maxRetries).
    // If the reaper bumped attemptCount, release()'s dead-letter gate would fire
    // on the very next heartbeat expiry — condemning an item that never failed.
    seedOrphanedClaim(state, { attemptCount: 7 });

    const report = await adapter.reapOrphanClaims();

    expect(report.reclaimed).toHaveLength(1);
    const pendingEntries = pendingByItemKey(state, ORPHANED_ITEM_KEY);
    expect(pendingEntries).toHaveLength(1);
    const parsed: SerializedQueueItem = JSON.parse(pendingEntries[0]!.member);
    // attemptCount is PRESERVED (finding 9). Only reclaimCount bumps.
    expect(parsed.attemptCount).toBe(7);
    expect(parsed.reclaimCount).toBe(1);
    // Not dead-lettered — pending contains the item, dead-letter untouched.
    // attemptCountBefore === attemptCountAfter (both 7) — the reaper is not
    // an execution-failure signal.
    expect(report.reclaimed[0]!.attemptCountBefore).toBe(7);
    expect(report.reclaimed[0]!.attemptCountAfter).toBe(7);
    expect(report.reclaimed[0]!.reclaimCountBefore).toBe(0);
    expect(report.reclaimed[0]!.reclaimCountAfter).toBe(1);
  });

  it("AD-9: reclaimed item's queueReason is 'resume' and priority = 0", async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state);

    await adapter.reapOrphanClaims();

    const pendingEntries = pendingByItemKey(state, ORPHANED_ITEM_KEY);
    expect(pendingEntries).toHaveLength(1);
    const pendingEntry = pendingEntries[0]!;
    // Resume tier: getPriorityScore('resume') is 0.{timestamp} (< 1).
    expect(pendingEntry.score).toBeGreaterThanOrEqual(0);
    expect(pendingEntry.score).toBeLessThan(1);
    const parsed: SerializedQueueItem = JSON.parse(pendingEntry.member);
    expect(parsed.queueReason).toBe('resume');
    expect(parsed.priority).toBeGreaterThanOrEqual(0);
    expect(parsed.priority).toBeLessThan(1);
  });

  it('FR-008: reclaim emits a single warn line with reclaimCountBefore + reclaimCountAfter distinguishing infra vs execution paths', async () => {
    const { redis, state } = createMockRedisWithState();
    const adapter = makeAdapter(redis, logger);

    seedOrphanedClaim(state, { attemptCount: 2 });

    await adapter.reapOrphanClaims();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'orphan-claim-reclaimed',
        workerId: ORPHANED_WORKER_ID,
        itemKey: ORPHANED_ITEM_KEY,
        ageMs: expect.any(Number),
        // attemptCount preserved across reclaim (finding 9).
        attemptCountBefore: 2,
        attemptCountAfter: 2,
        reclaimCountBefore: 0,
        reclaimCountAfter: 1,
        reason: 'orphaned-claim-no-heartbeat',
      }),
      'Reclaimed orphaned queue claim (worker heartbeat absent)',
    );

    // One warn per reclaim; not gated by transition-edge tracking.
    const reclaimWarns = logger.warn.mock.calls.filter(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as Record<string, unknown>).event === 'orphan-claim-reclaimed',
    );
    expect(reclaimWarns).toHaveLength(1);
  });
});
