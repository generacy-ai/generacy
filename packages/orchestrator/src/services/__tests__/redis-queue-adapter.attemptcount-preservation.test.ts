import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Redis as IORedis } from 'ioredis';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1069 — SC-005 + SC-006 attemptCount semantics regression suite.
 *
 * Three blocks:
 *   (a) 100 repeated lease-expiry cycles — asserts `requeueForResume`
 *       preserves `attemptCount` bit-identical (FR-003, SC-005).
 *   (b) 100 repeated retry cycles — asserts `release` increments
 *       `attemptCount` by exactly one per cycle (FR-004).
 *   (c) One release ×maxRetries cycle — asserts dead-letter fires on
 *       the exact `maxRetries`-th call and item is `SREM`'d from
 *       `IN_FLIGHT_KEY` (SC-006).
 */

const PENDING_KEY = 'orchestrator:queue:pending';
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
const DEAD_LETTER_KEY = 'orchestrator:queue:dead-letter';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';

const DB = 12;
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

const WORKER_ID = 'worker-1069-attemptcount';

async function seedClaimedItemWithHeartbeat(
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
  await redis.set(`${HEARTBEAT_KEY_PREFIX}${workerId}:heartbeat`, '1');
}

async function readOnlyPendingMember(
  redis: IORedis,
): Promise<SerializedQueueItem> {
  const [raw] = await redis.zrange(PENDING_KEY, 0, 0);
  expect(raw).toBeTruthy();
  return JSON.parse(raw!);
}

let redis: IORedis;

describeReal('RedisQueueAdapter — attemptCount preservation (#1069 SC-005 + SC-006)', () => {
  beforeEach(async () => {
    redis = new IORedis(REDIS_URL);
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it('(a) FR-003 / SC-005 — 100 repeated lease-expiry cycles: requeueForResume preserves attemptCount bit-identical', async () => {
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries: 3,
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';
    const INITIAL_ATTEMPT_COUNT = 5;

    for (let i = 0; i < 100; i++) {
      const seeded: SerializedQueueItem = {
        ...item,
        attemptCount: INITIAL_ATTEMPT_COUNT,
        itemKey,
        priority: 1000,
        claimedAt: new Date().toISOString(),
      };
      await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

      await adapter.requeueForResume(WORKER_ID, item);

      const parsedMember = await readOnlyPendingMember(redis);
      expect(parsedMember.attemptCount).toBe(INITIAL_ATTEMPT_COUNT);
      expect(parsedMember.queueReason).toBe('resume');

      await redis.flushdb();
    }
  });

  it('(b) FR-004 — 100 repeated retry cycles: release increments attemptCount by exactly one per cycle', async () => {
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries: 200,
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';

    for (let i = 0; i < 100; i++) {
      const seedAttempt = i;
      const seeded: SerializedQueueItem = {
        ...item,
        attemptCount: seedAttempt,
        itemKey,
        priority: 1000,
        claimedAt: new Date().toISOString(),
      };
      await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

      await adapter.release(WORKER_ID, item);

      const parsedMember = await readOnlyPendingMember(redis);
      expect(parsedMember.attemptCount).toBe(seedAttempt + 1);
      expect(parsedMember.queueReason).toBe('retry');

      await redis.flushdb();
    }
  });

  it('(c) SC-006 — release × maxRetries dead-letters on exactly the maxRetries-th call and SREMs in-flight', async () => {
    const maxRetries = 3;
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries,
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';

    const seeded: SerializedQueueItem = {
      ...item,
      attemptCount: 0,
      itemKey,
      priority: 1000,
      claimedAt: new Date().toISOString(),
    };
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    // Call 1: seeded 0 → +1 = 1 (< 3) → retry.
    await adapter.release(WORKER_ID, item);
    let parsed = await readOnlyPendingMember(redis);
    expect(parsed.attemptCount).toBe(1);
    expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
    expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(0);

    const seed1: SerializedQueueItem = { ...seeded, attemptCount: 1 };
    await redis.del(PENDING_KEY);
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seed1);

    // Call 2: seeded 1 → +1 = 2 (< 3) → retry.
    await adapter.release(WORKER_ID, item);
    parsed = await readOnlyPendingMember(redis);
    expect(parsed.attemptCount).toBe(2);
    expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
    expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(0);

    const seed2: SerializedQueueItem = { ...seeded, attemptCount: 2 };
    await redis.del(PENDING_KEY);
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seed2);

    // Call 3 (maxRetries-th): seeded 2 → +1 = 3 (>= 3) → DEAD-LETTER.
    await adapter.release(WORKER_ID, item);
    expect(await redis.zcard(PENDING_KEY)).toBe(0);
    expect(await redis.zcard(DEAD_LETTER_KEY)).toBe(1);
    const [dlRaw] = await redis.zrange(DEAD_LETTER_KEY, 0, 0);
    const dlParsed: SerializedQueueItem = JSON.parse(dlRaw!);
    expect(dlParsed.attemptCount).toBe(3);
    // FR-006 SREM invariant.
    expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(0);
  });
});

afterAll(async () => {
  try {
    if (redis && redis.status !== 'end') await redis.quit();
  } catch {
    /* best-effort */
  }
});
