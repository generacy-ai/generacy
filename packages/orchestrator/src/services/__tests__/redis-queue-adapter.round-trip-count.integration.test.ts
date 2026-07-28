import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { Redis as IORedis } from 'ioredis';
import { RedisQueueAdapter } from '../redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../types/index.js';

/**
 * #1069 — Separate plain test per Clarifications Q4 rider: SC-003 + SC-004.
 *
 * Asserts that both `requeueForResume()` and `release()` (retry AND
 * dead-letter branches) issue exactly ONE Lua-script command per happy-
 * path invocation. Wraps `redis.sendCommand` with a spy that counts
 * commands the client actually ships to Redis — this is the exact
 * measure of "round trip count" from the caller's perspective.
 *
 * MONITOR was tried first and rejected because it also reports the
 * `redis.call(...)` sub-commands issued FROM INSIDE the Lua script, so
 * "one EVALSHA + N sub-commands" would look like N+1 client commands.
 * The `sendCommand` spy is client-side only: sub-commands never touch it.
 *
 * The pre-fix implementation issued at least three commands per call
 * (HGET → MULTI: HDEL + DEL + ZADD, three round trips). Post-fix: one
 * `EVALSHA` (or the initial `EVAL`) for the whole read-and-mutate. Q1
 * → A folds dead-letter into the same script so both branches share
 * this guarantee — hence the deliberate "dead-letter branch: exactly
 * 1 EVALSHA" assertion, which regresses if a future refactor peels
 * dead-letter back out into a client-side pipeline.
 */

const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';

const DB = 15;
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

const WORKER_ID = 'worker-1069-roundtrip';

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

/**
 * Wrap `redis.sendCommand` so every command the client ships is counted
 * by name. Returns a `dispose()` fn that restores the original method
 * and a `getCounts()` fn that returns the current tally.
 *
 * `sendCommand` is the ioredis narrow-waist: `defineCommand`-registered
 * scripts, standard verbs (HGET, ZADD, ...), and transactions all funnel
 * through here. Sub-commands issued via `redis.call(...)` INSIDE a Lua
 * script never touch this path — they execute server-side. That's why
 * this is the correct scope for a "round trip count" assertion.
 */
function attachSendCommandSpy(redis: IORedis): {
  getCounts: () => Map<string, number>;
  dispose: () => void;
} {
  const original = (redis as unknown as { sendCommand: (cmd: unknown, stream?: unknown) => unknown })
    .sendCommand.bind(redis);
  const counts = new Map<string, number>();
  const spy = function (this: IORedis, command: { name: string }, stream?: unknown) {
    const verb = command?.name?.toUpperCase();
    if (verb) counts.set(verb, (counts.get(verb) ?? 0) + 1);
    return original(command as unknown, stream);
  };
  (redis as unknown as { sendCommand: unknown }).sendCommand = spy;
  return {
    getCounts: () => counts,
    dispose: () => {
      (redis as unknown as { sendCommand: unknown }).sendCommand = original;
    },
  };
}

let redis: IORedis;

describeReal('RedisQueueAdapter — round-trip count (#1069 SC-003 + SC-004)', () => {
  beforeEach(async () => {
    redis = new IORedis(REDIS_URL);
    await redis.flushdb();
  });

  afterEach(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it('requeueForResume happy path: exactly 1 EVALSHA (or EVAL fallback)', async () => {
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries: 3,
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';
    const seeded: SerializedQueueItem = {
      ...item,
      attemptCount: 2,
      itemKey,
      priority: 1000,
      claimedAt: new Date().toISOString(),
    };
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    // Warm up defineCommand so the counted call is a deterministic single
    // `EVALSHA` (or `EVAL` if the SHA cache missed).
    await adapter.requeueForResume(WORKER_ID, sampleItem({ issueNumber: 9999999 }));
    await redis.flushdb();
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    const spy = attachSendCommandSpy(redis);
    try {
      await adapter.requeueForResume(WORKER_ID, item);
      const counts = spy.getCounts();
      const scriptCommands =
        (counts.get('EVALSHA') ?? 0) + (counts.get('EVAL') ?? 0);
      expect(scriptCommands).toBe(1);
      // No client-side HGET / HDEL / DEL / ZADD — all folded into the script.
      expect(counts.get('HGET') ?? 0).toBe(0);
      expect(counts.get('HDEL') ?? 0).toBe(0);
      expect(counts.get('ZADD') ?? 0).toBe(0);
      expect(counts.get('DEL') ?? 0).toBe(0);
      expect(counts.get('MULTI') ?? 0).toBe(0);
    } finally {
      spy.dispose();
    }
  });

  it('release retry branch happy path: exactly 1 EVALSHA', async () => {
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries: 3,
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';
    const seeded: SerializedQueueItem = {
      ...item,
      attemptCount: 1, // +1 = 2, retry branch (below maxRetries=3)
      itemKey,
      priority: 1000,
      claimedAt: new Date().toISOString(),
    };
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    await adapter.release(WORKER_ID, sampleItem({ issueNumber: 9999999 }));
    await redis.flushdb();
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    const spy = attachSendCommandSpy(redis);
    try {
      await adapter.release(WORKER_ID, item);
      const counts = spy.getCounts();
      const scriptCommands =
        (counts.get('EVALSHA') ?? 0) + (counts.get('EVAL') ?? 0);
      expect(scriptCommands).toBe(1);
      expect(counts.get('HGET') ?? 0).toBe(0);
      expect(counts.get('MULTI') ?? 0).toBe(0);
      expect(counts.get('SREM') ?? 0).toBe(0);
    } finally {
      spy.dispose();
    }
  });

  it('release dead-letter branch happy path: exactly 1 EVALSHA (Q1=A load-bearing)', async () => {
    // The load-bearing assertion: dead-letter is folded into the SAME
    // script as retry per Clarifications Q1 → A. Peeling it back out
    // into a separate `MULTI: ... .zadd(DEAD_LETTER_KEY, ...).srem(...)`
    // pipeline would regress this test.
    const adapter = new RedisQueueAdapter(redis, createLogger(), {
      maxRetries: 3, // seeded +1 == 3 → dead-letter
      maxRunDurationMs: 1_800_000,
      heartbeatCheckIntervalMs: 100,
    });

    const item = sampleItem();
    const itemKey = 'generacy-ai/generacy#1069';
    const seeded: SerializedQueueItem = {
      ...item,
      attemptCount: 2,
      itemKey,
      priority: 1000,
      claimedAt: new Date().toISOString(),
    };
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    // Warm-up on a distinct dead-letter-eligible item so the script SHA
    // is cached before the counted invocation.
    const warmSeed: SerializedQueueItem = {
      ...seeded,
      itemKey: 'warmup#0',
    };
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, 'warmup#0', warmSeed);
    await adapter.release(WORKER_ID, sampleItem({ issueNumber: 9999999 }));
    await redis.flushdb();
    await seedClaimedItemWithHeartbeat(redis, WORKER_ID, itemKey, seeded);

    const spy = attachSendCommandSpy(redis);
    try {
      await adapter.release(WORKER_ID, item);
      const counts = spy.getCounts();
      const scriptCommands =
        (counts.get('EVALSHA') ?? 0) + (counts.get('EVAL') ?? 0);
      expect(scriptCommands).toBe(1);
      expect(counts.get('HGET') ?? 0).toBe(0);
      expect(counts.get('MULTI') ?? 0).toBe(0);
      // Critical: SREM must fire INSIDE the script (as a redis.call from Lua),
      // not as a client-side command that would count here.
      expect(counts.get('SREM') ?? 0).toBe(0);
    } finally {
      spy.dispose();
    }
  });
});

afterAll(async () => {
  try {
    if (redis && redis.status !== 'end') await redis.quit();
  } catch {
    /* best-effort */
  }
});
