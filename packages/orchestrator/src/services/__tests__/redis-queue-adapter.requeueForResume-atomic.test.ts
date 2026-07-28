import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Redis as IORedis } from 'ioredis';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1069 — Atomic-re-pend regression suite for `requeueForResume()`.
 *
 * Exercises `REQUEUE_FOR_RESUME_SCRIPT` against real ioredis + real Redis
 * (7.x). The stateful-TypeScript mocks used elsewhere cannot catch the
 * mis-issued-command-sequence class of bug that this fix closes — only
 * the real Lua runtime + real ZSET member semantics can.
 *
 * The deterministic-interleave `describe` is the load-bearing block: it
 * arranges the state such that a full `reapOrphanClaims()` completes
 * BEFORE our `requeueForResume()` starts, and asserts the post-fix
 * script (with its atomic inside-Lua `HGET`) sees the reaper's `HDEL`,
 * returns `{0, -1}`, and produces exactly one pending member (the
 * reaper's re-pend). The T017 baseline-demonstration procedure re-runs
 * this file against `HEAD~1` to show it FAILS on the pre-fix code, where
 * the client's `HGET` + `MULTI: HDEL + DEL + ZADD` sequence produces a
 * second distinct pending member.
 */

const PENDING_KEY = 'orchestrator:queue:pending';
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';

// Per-file keyspace isolation via a random keyPrefix so vitest's parallel
// workers cannot stomp on one another when they share a Redis instance.
// ioredis auto-prepends the prefix to every key including those inside
// `defineCommand` Lua scripts.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const KEY_PREFIX = `t1069req-${Math.random().toString(36).slice(2, 10)}:`;
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
    queueReason: 'resume',
    ...overrides,
  };
}

const HEARTBEAT_CHECK_INTERVAL_MS = 100;
const GRACE_WINDOW_MS = 2 * HEARTBEAT_CHECK_INTERVAL_MS;
const WORKER_ID = 'worker-1069-req-atomic';

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

async function flushPrefix(redis: IORedis, prefix: string): Promise<void> {
  // Delete only the keys owned by this test file's prefix. Called from
  // beforeEach + afterEach so tests inside the file stay isolated too.
  // NOTE: ioredis auto-prepends the client's `keyPrefix` to KEY arguments
  // of most commands, but NOT to arguments that look like patterns for
  // SCAN. We must include the prefix explicitly in the SCAN pattern.
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${prefix}*`,
      'COUNT',
      100,
    );
    cursor = next;
    for (const k of keys) {
      // The returned keys already include the prefix; ioredis would
      // double-prefix if we passed them via a keyPrefix-aware command.
      // `unlink` accepts full keys and does NOT re-prefix.
      await (redis as unknown as { unlink: (k: string) => Promise<number> }).unlink(k);
    }
  } while (cursor !== '0');
}

let redis: IORedis;

describeReal('RedisQueueAdapter — requeueForResume atomic (#1069)', () => {
  beforeEach(async () => {
    redis = new IORedis(REDIS_URL, { keyPrefix: KEY_PREFIX });
    await flushPrefix(redis, KEY_PREFIX);
  });

  afterEach(async () => {
    await flushPrefix(redis, KEY_PREFIX);
    await redis.quit();
  });

  describe('deterministic reaper-wins interleave', () => {
    it('when reapOrphanClaims completes before requeueForResume, script sees HGET === nil, returns {0, -1}, ZCARD pending == 1', async () => {
      const logger = createLogger();
      const adapter = new RedisQueueAdapter(redis, logger, {
        maxRetries: 3,
        maxRunDurationMs: 1_800_000,
        heartbeatCheckIntervalMs: HEARTBEAT_CHECK_INTERVAL_MS,
      });

      const item = sampleItem();
      const itemKey = 'generacy-ai/generacy#1069';
      const oldEnqueuedAt = new Date(Date.now() - 60_000).toISOString();
      const oldClaimedAt = new Date(Date.now() - GRACE_WINDOW_MS - 100).toISOString();
      const seeded: SerializedQueueItem = {
        ...item,
        enqueuedAt: oldEnqueuedAt,
        claimedAt: oldClaimedAt,
        attemptCount: 2,
        itemKey,
        priority: 0,
      };

      // Step 1: seed the wedge (claim + in-flight; no heartbeat → reaper eligible).
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);

      // Step 2: reaper completes atomically — HDELs claim, ZADDs reclaim payload.
      const report = await adapter.reapOrphanClaims();
      expect(report.reclaimed).toHaveLength(1);
      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      expect(
        await redis.hget(`${CLAIMED_KEY_PREFIX}${WORKER_ID}`, itemKey),
      ).toBeNull();

      // Step 3: lease-expiry firing arrives late — script's inside-Lua HGET
      // now returns nil. Post-fix: script returns {0, -1} and never issues
      // ZADD. Pre-fix: client HGET already succeeded pre-reaper AND client
      // MULTI would fire ZADD blindly here → ZCARD == 2 (the exact bug).
      await adapter.requeueForResume(WORKER_ID, item);

      // Post-fix invariant: pending has exactly ONE member (reaper's re-pend).
      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      // Item stays in-flight (reaper did not SREM; requeueForResume never SREMs).
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
      // Logger emitted the reaper-race info line.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: WORKER_ID, itemKey }),
        expect.stringContaining('reaper race'),
      );
    });

    it('when claim is present (no reaper race), script re-pends with attemptCount preserved and returns {1, N}', async () => {
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
        attemptCount: 4,
        itemKey,
        priority: 1000,
        claimedAt: new Date().toISOString(),
      };
      await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);
      // Add a heartbeat so we're NOT racing with the reaper here.
      await redis.set(`${HEARTBEAT_KEY_PREFIX}${WORKER_ID}:heartbeat`, '1');

      await adapter.requeueForResume(WORKER_ID, item);

      expect(await redis.zcard(PENDING_KEY)).toBe(1);
      const [member] = await redis.zrange(PENDING_KEY, 0, 0);
      const parsedMember: SerializedQueueItem = JSON.parse(member!);
      // FR-003 — attemptCount preserved verbatim.
      expect(parsedMember.attemptCount).toBe(4);
      expect(parsedMember.queueReason).toBe('resume');
      // A6 — claimedAt stripped for the next claim cycle.
      expect(parsedMember.claimedAt).toBeUndefined();
      // Claim hash + heartbeat both cleared.
      expect(
        await redis.hget(`${CLAIMED_KEY_PREFIX}${WORKER_ID}`, itemKey),
      ).toBeNull();
      expect(
        await redis.exists(`${HEARTBEAT_KEY_PREFIX}${WORKER_ID}:heartbeat`),
      ).toBe(0);
      // In-flight preserved (no SREM on requeueForResume).
      expect(await redis.sismember(IN_FLIGHT_KEY, itemKey)).toBe(1);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: WORKER_ID,
          itemKey,
          attemptCount: 4,
          reason: 'lease-expiry',
        }),
        expect.stringContaining('Item re-pended at resume priority'),
      );
    });
  });

  describe('natural-race smoke test (N=100 Promise.all pairs)', () => {
    it('regardless of scheduler ordering, ZCARD pending == 1 after every pair', async () => {
      const adapter = new RedisQueueAdapter(redis, createLogger(), {
        maxRetries: 3,
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
          attemptCount: 0,
          itemKey,
          priority: 0,
        };
        await seedClaimedItemWithoutHeartbeat(redis, WORKER_ID, itemKey, seeded);

        // Race: whichever finishes first, the other must see the after-state
        // and produce the correct invariant (ZCARD == 1) — the atomic scripts
        // guarantee no interleave can produce a duplicate.
        await Promise.all([
          adapter.reapOrphanClaims(),
          adapter.requeueForResume(WORKER_ID, item),
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

        // Clean up between iterations to bound Redis memory.
        await flushPrefix(redis, KEY_PREFIX);
      }
    });
  });
});

// Best-effort connection cleanup in case a test suite crash left the client open.
afterAll(async () => {
  try {
    if (redis && redis.status !== 'end') await redis.quit();
  } catch {
    /* best-effort */
  }
});
