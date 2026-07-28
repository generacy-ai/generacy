import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Redis as IORedis } from 'ioredis';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1069 — Atomic-re-pend regression suite for `release()` (both branches).
 *
 * `RELEASE_SCRIPT` folds retry AND dead-letter into a single Lua script
 * (Clarifications Q1 → A) so SC-004's "exactly 1 round trip" invariant
 * holds on both branches. This suite exercises:
 *
 *   1. Retry branch: `attemptCount + 1 < maxRetries` — script re-pends
 *      at retry priority, preserves in-flight SET membership (FR-006).
 *   2. Dead-letter branch: `attemptCount + 1 >= maxRetries` — script
 *      HDELs claim, DELs heartbeat, ZADDs dead-letter, SREMs in-flight
 *      (also FR-006).
 *   3. Reaper-race no-op branch (code 0): inside-Lua HGET sees nil,
 *      returns {0, -1}, does NOT SREM in-flight (whichever concurrent
 *      actor won owns that invariant).
 *
 * Baseline demo (T017): re-run this file against `HEAD~1` — pre-fix
 * `hget` + client-side `multi` produces a second distinct pending or
 * dead-letter member.
 */

const PENDING_KEY = 'orchestrator:queue:pending';
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
const DEAD_LETTER_KEY = 'orchestrator:queue:dead-letter';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';

// Per-file Redis DB isolation. See sibling file for the keyPrefix-vs-DB
// rationale — SCAN pattern is not prefixed by ioredis, so keyPrefix
// would break reapOrphanClaims.
const DB = 14;
const REDIS_URL_BASE = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const REDIS_URL = `${REDIS_URL_BASE.replace(/\/\d+$/, '')}/${DB}`;
const skipReason = process.env.SKIP_REAL_REDIS_TESTS === '1'
  ? 'skipped via SKIP_REAL_REDIS_TESTS=1'
  : null;
const describeReal = skipReason ? describe.skip : describe;

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function sampleItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: 'generacy-ai',
    repo: 'generacy',
    issueNumber: 1069,
    workflowName: 'speckit-feature',
    command: 'address-pr-feedback',
    priority: 1000,
    enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
    queueReason: 'new',
    ...overrides,
  };
}

const HEARTBEAT_CHECK_INTERVAL_MS = 100;
const GRACE_WINDOW_MS = 2 * HEARTBEAT_CHECK_INTERVAL_MS;
const WORKER_ID = 'worker-1069-release-atomic';

async function seedClaimedItemWithoutHeartbeat(
  redis: IORedis,
  workerId: string,
  itemKey: string,
  parsed: SerializedQueueItem,
): Promise<void> {
  await redis.hset(
    `${CLAIMED_KEY_PREFIX}${workerId}`,
    itemKey,
    JSON.stringify(parsed),
  );
  await redis.sadd(IN_FLIGHT_KEY, itemKey);
  // No heartbeat SET — reaper eligible.
}

let redis: IORedis;

describeReal('RedisQueueAdapter — release atomic (#1069)', () => {
  beforeEach(async () => {
    redis = new IORedis(REDIS_URL);
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  describe('retry branch', () => {
    it('script re-pends at retry priority, preserves in-flight SET (FR-006), returns {1, attemptCount+1}', async () => {
      const logger = createLogger();
      const adapter = new RedisQueueAdapter(redis, logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const item = sampleItem();
      const itemKey = 'generacy-ai/generacy#1069';
      const seeded: SerializedQueueItem = {
        ...item,
        attemptCount: 1, // +1 = 2, still below maxRetries=3
        itemKey,
        priority: 1000,
        claimedAt: new Date().toISOString(),
      };
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);
      await redis.set(`${HEARTBEAT_KEY_PREFIX}${WORKER_ID}:heartbeat`, '1');

      await adapter.release(WORKER_ID, item);

      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      const [member] = await redis.zrange(PENDING_KEY, 0, 0);
      const parsedMember: SerializedQueueItem = JSON.parse(member!);
      expect(parsedMember.attemptCount).toBe(2); // +1 from claim payload
      expect(parsedMember.queueReason).toBe('retry');
      expect(parsedMember.claimedAt).toBeUndefined();
      expect(
        await redis.hget(`${CLAIMED_KEY_PREFIX}${WORKER_ID}`, itemKey),
      ).toBeNull();
      expect(
        await redis.exists(`${HEARTBEAT_KEY_PREFIX}${WORKER_ID}:heartbeat`),
      ).toBe(0);
      // FR-006 — in-flight PRESERVED on retry branch.
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
      expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(0);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: WORKER_ID, itemKey, attemptCount: 2 }),
        'Item released back to pending queue',
      );
    });

    it('deterministic reaper-wins: when reapOrphanClaims completes first, script returns {0, -1} and ZCARD pending == 1 (retry variant)', async () => {
      const logger = createLogger();
      const adapter = new RedisQueueAdapter(redis, logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const item = sampleItem();
      const itemKey = 'generacy-ai/generacy#1069';
      const oldClaimedAt = new Date(Date.now() - GRACE_WINDOW_MS - 100).toISOString();
      const seeded: SerializedQueueItem = {
        ...item,
        claimedAt: oldClaimedAt,
        attemptCount: 1,
        itemKey,
        priority: 1000,
      };
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);

      // Reaper wins.
      const report = await adapter.reapOrphanClaims();
      expect(report.reclaimed).toHaveLength(1);
      expect(await redis.zcard(PENDING_KEY)).toBe(1);

      // release() arrives late; script sees HGET === nil.
      await adapter.release(WORKER_ID, item);

      // No duplicate pending member; reaper's re-pend is the only writer.
      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      // No dead-letter member (retry branch did not fire).
      expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(0);
      // FR-006 no-op branch: in-flight untouched by our script.
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: WORKER_ID, itemKey }),
        expect.stringContaining('reaper race'),
      );
    });
  });

  describe('dead-letter branch (FR-002 Q1=A)', () => {
    it('script dead-letters, SREMs in-flight (FR-006), returns {2, attemptCount+1}', async () => {
      const logger = createLogger();
      const adapter = new RedisQueueAdapter(redis, logger, {
        maxRetries: 3, // seeded attemptCount = 2 → +1 = 3 → dead-letter
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const item = sampleItem();
      const itemKey = 'generacy-ai/generacy#1069';
      const seeded: SerializedQueueItem = {
        ...item,
        attemptCount: 2, // +1 = 3, meets maxRetries=3
        itemKey,
        priority: 1000,
        claimedAt: new Date().toISOString(),
      };
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);
      await redis.set(`${HEARTBEAT_KEY_PREFIX}${WORKER_ID}:heartbeat`, '1');

      await adapter.release(WORKER_ID, item);

      expect(await redis.zcard(PENDING_KEY)).toBe(0);
      expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(1);
      const [dlMember] = await redis.zrange(DEAD_LETTER_KEY, 0, 0);
      const parsedDl: SerializedQueueItem = JSON.parse(dlMember!);
      expect(parsedDl.attemptCount).toBe(3);
      expect(parsedDl.claimedAt).toBeUndefined();
      // FR-006 — in-flight REMOVED on dead-letter branch.
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(0);
      expect(
        await redis.hget(`${CLAIMED_KEY_PREFIX}${WORKER_ID}`, itemKey),
      ).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: WORKER_ID,
          itemKey,
          attemptCount: 3,
          maxRetries: 3,
        }),
        'Item dead-lettered after max retries',
      );
    });

    it('deterministic reaper-wins: when reapOrphanClaims completes first on a dead-letter-eligible seed, script returns {0, -1}, in-flight untouched by our script (SISMEMBER == 1), dead-letter stays empty', async () => {
      const logger = createLogger();
      const adapter = new RedisQueueAdapter(redis, logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const item = sampleItem();
      const itemKey = 'generacy-ai/generacy#1069';
      const oldClaimedAt = new Date(Date.now() - GRACE_WINDOW_MS - 100).toISOString();
      const seeded: SerializedQueueItem = {
        ...item,
        claimedAt: oldClaimedAt,
        attemptCount: 2, // would dead-letter if release ran on the claim
        itemKey,
        priority: 1000,
      };
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);

      // Reaper wins first.
      const report = await adapter.reapOrphanClaims();
      expect(report.reclaimed).toHaveLength(1);
      expect(await redis.zcard(PENDING_KEY)).toBe(1);

      // release() arrives late; script's HGET returns nil → no-op.
      await adapter.release(WORKER_ID, item);

      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      // Critical FR-006 assertion: because the release() script no-op'd,
      // in-flight SET is UNTOUCHED. If the pre-fix client-side MULTI had
      // fired, it would have SREM'd here — creating a pending member with
      // NO in-flight entry, breaking the (pending ∪ claimed) invariant.
      expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(0);
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: WORKER_ID, itemKey }),
        expect.stringContaining('reaper race'),
      );
    });
  });

  describe('natural-race smoke test (N=100 Promise.all pairs, retry-eligible)', () => {
    it('regardless of scheduler ordering, ZCARD pending == 1 after every pair', async () => {
      const adapter = new RedisQueueAdapter(redis, createLogger(), {
        maxRetries: 10, // keep every seeded item in the retry branch
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const N = 100;
      for (let i = 0; i < N; i++) {
        const itemKey = `generacy-ai/generacy#${1069000 + i}`;
        const item = sampleItem({ issueNumber: 1069000 + i });
        const oldClaimedAt = new Date(Date.now() - GRACE_WINDOW_MS - 100).toISOString();
        const seeded: SerializedQueueItem = {
          ...item,
          claimedAt: oldClaimedAt,
          attemptCount: 1,
          itemKey,
          priority: 1000,
        };
        await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);

        await Promise.all([
          adapter.reapOrphanClaims(),
          adapter.release(WORKER_ID, item),
        ]);

        const members = await redis.zrange(PENDING_KEY, 0, -1);
        const matching = members.filter((m) => {
          try {
            return (JSON.parse(m) as SerializedQueueItem).itemKey === itemKey;
          } catch {
            return false;
          }
        });
        expect(matching).toHaveLength(1);
        await redis.flushdb();
      }
    });
  });
});

afterAll(async () => {
  try {
    if (redis && redis.status !== 'end') await redis.quit();
  } catch {
    /* best-effort */
  }
});
