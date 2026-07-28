import { describe, it, expect, vi } from 'vitest';
import {
  RedisQueueAdapter,
  _ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS as ENQUEUE_IF_ABSENT_SCRIPT,
  _REQUEUE_FOR_RESUME_SCRIPT_FOR_TESTS as REQUEUE_FOR_RESUME_SCRIPT,
  _RELEASE_SCRIPT_FOR_TESTS as RELEASE_SCRIPT,
} from '../redis-queue-adapter.js';
import type { QueueItem } from '../../types/index.js';

/**
 * #1060 PR #1065 review finding 3 — static assertions over the Lua script
 * text + `defineCommand` registration.
 *
 * The stateful-mock harnesses in `redis-queue-adapter.enqueue-invariant.test.ts`
 * and `queue-adapter-parity.test.ts` re-implement the Lua semantics in
 * TypeScript for hermetic execution — a correct implementation, but not
 * the same bytes Redis will actually execute. That harness cannot detect
 * a mis-issued command sequence (e.g. a `ZADD` with no paired `SADD`,
 * or KEYS[1]/KEYS[2] transposed), which is precisely the class of bug
 * #1060 exists to fix.
 *
 * This file's assertions are hermetic and byte-exact:
 *   - The script text contains SISMEMBER / SADD / ZADD in the
 *     correct order and with the correct KEYS/ARGV indices.
 *   - `defineCommand('enqueueIfAbsent', ...)` is called with the
 *     correct `numberOfKeys` and script body.
 *   - `enqueue()` and `enqueueIfAbsent()` both route through the
 *     `enqueueIfAbsent` command (PR #1065 review findings 5+6 —
 *     no duplicate `enqueueItem` command).
 *
 * Direct precedent: #1051 `repo-checkout.test.ts` (SC-005) statically
 * asserts both `git fetch` sites include `--prune`.
 */

describe('RedisQueueAdapter — Lua script text (#1060 script-wiring assertions)', () => {
  it('ENQUEUE_IF_ABSENT_SCRIPT runs SISMEMBER, then guarded SADD, then ZADD, in that order', () => {
    // Order matters: SISMEMBER on the in-flight SET is the dedupe gate;
    // SADD must happen only if the gate passes; ZADD extends pending.
    const src = ENQUEUE_IF_ABSENT_SCRIPT;

    const sismemberIdx = src.indexOf('SISMEMBER');
    const saddIdx = src.indexOf('SADD');
    const zaddIdx = src.indexOf('ZADD');

    expect(sismemberIdx, 'SISMEMBER must be present').toBeGreaterThanOrEqual(0);
    expect(saddIdx, 'SADD must be present').toBeGreaterThan(sismemberIdx);
    expect(zaddIdx, 'ZADD must be present').toBeGreaterThan(saddIdx);
  });

  it('SISMEMBER checks KEYS[2] (the in-flight SET), not KEYS[1] (pending)', () => {
    // A transposed KEYS pair would still register — the script would run
    // but it would check pending for membership (always false), never
    // dedupe, and produce two ZSET members. This is exactly the class of
    // bug the mock harness cannot detect.
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(/SISMEMBER'?\s*,\s*KEYS\[2\]/);
  });

  it('SADD writes to KEYS[2] (in-flight SET) with the itemKey ARGV[1]', () => {
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(
      /SADD'?\s*,\s*KEYS\[2\]\s*,\s*ARGV\[1\]/,
    );
  });

  it('ZADD writes to KEYS[1] (pending) with the priority ARGV[2] and payload ARGV[3]', () => {
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(
      /ZADD'?\s*,\s*KEYS\[1\]/,
    );
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(/ARGV\[2\]/);
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(/ARGV\[3\]/);
  });

  it('returns 0 when SISMEMBER reports the itemKey is in flight', () => {
    // Guarded early-return prevents the SADD/ZADD from running on
    // collision. Without this branch every call would upsert.
    expect(ENQUEUE_IF_ABSENT_SCRIPT).toMatch(/exists\s*==\s*1[\s\S]*return\s*0/);
  });
});

describe('RedisQueueAdapter — defineCommand wiring (#1060 script-wiring assertions)', () => {
  function createMinimalMockRedis(): {
    redis: unknown;
    defineCommand: ReturnType<typeof vi.fn>;
    enqueueIfAbsent: ReturnType<typeof vi.fn>;
  } {
    const defineCommand = vi.fn();
    const enqueueIfAbsent = vi.fn().mockResolvedValue(1);
    const redis: Record<string, unknown> = {
      defineCommand,
      enqueueIfAbsent,
      zrange: vi.fn().mockResolvedValue([]),
      scan: vi.fn().mockResolvedValue(['0', []]),
      hget: vi.fn().mockResolvedValue(null),
    };
    return { redis, defineCommand, enqueueIfAbsent };
  }

  function makeAdapter(redis: unknown) {
    return new RedisQueueAdapter(redis as import('ioredis').Redis, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
  }

  const sampleItem: QueueItem = {
    owner: 'test-org',
    repo: 'test-repo',
    issueNumber: 1060,
    workflowName: 'speckit-feature',
    command: 'process',
    priority: 1000,
    enqueuedAt: new Date().toISOString(),
    queueReason: 'new',
  };

  it('defineCommand("enqueueIfAbsent") is called with numberOfKeys=2 and the ENQUEUE_IF_ABSENT_SCRIPT body', async () => {
    // #1060 PR #1065 review finding 5 — numberOfKeys must match the KEYS
    // slots the script actually references (KEYS[1] pending + KEYS[2]
    // in-flight). A stale `numberOfKeys: 3` (from the deleted
    // `enqueueItem` command) would declare a phantom third key that
    // would break under Redis Cluster's CROSSSLOT check.
    const { redis, defineCommand } = createMinimalMockRedis();
    const adapter = makeAdapter(redis);
    await adapter.enqueue(sampleItem);
    expect(defineCommand).toHaveBeenCalledWith('enqueueIfAbsent', {
      numberOfKeys: 2,
      lua: ENQUEUE_IF_ABSENT_SCRIPT,
    });
  });

  it('enqueue() invokes the enqueueIfAbsent command with exactly 5 args (2 keys + 3 argv), NOT the deleted enqueueItem command', async () => {
    // #1060 PR #1065 review finding 6 — `enqueueItem` was a byte-identical
    // duplicate of `enqueueIfAbsent`. It has been consolidated. Any
    // regression that re-adds it would register a second command and
    // route enqueue() through the wrong one.
    const { redis, enqueueIfAbsent } = createMinimalMockRedis();
    (redis as Record<string, unknown>).enqueueItem = vi.fn(() => {
      throw new Error(
        'FAIL: enqueue() must NOT route through enqueueItem (deleted per PR #1065 review finding 6)',
      );
    });
    const adapter = makeAdapter(redis);
    await adapter.enqueue(sampleItem);
    expect(enqueueIfAbsent).toHaveBeenCalledOnce();
    // 2 keys + itemKey + priority + payload = 5 args.
    expect(enqueueIfAbsent.mock.calls[0]).toHaveLength(5);
    expect(enqueueIfAbsent.mock.calls[0][0]).toBe('orchestrator:queue:pending');
    expect(enqueueIfAbsent.mock.calls[0][1]).toBe('orchestrator:queue:in-flight-items');
    expect(enqueueIfAbsent.mock.calls[0][2]).toBe('test-org/test-repo#1060');
  });

  it('enqueueIfAbsent() invokes the same enqueueIfAbsent command (cross-verb parity)', async () => {
    const { redis, enqueueIfAbsent } = createMinimalMockRedis();
    const adapter = makeAdapter(redis);
    await adapter.enqueueIfAbsent(sampleItem);
    expect(enqueueIfAbsent).toHaveBeenCalledOnce();
    expect(enqueueIfAbsent.mock.calls[0]).toHaveLength(5);
  });
});

describe('RedisQueueAdapter — REQUEUE_FOR_RESUME_SCRIPT text (#1069 script-wiring assertions)', () => {
  it('script contains HGET, HDEL, DEL, ZADD in the correct order (single atomic pass)', () => {
    // Order matters: HGET reads the claim, HDEL clears it, DEL clears
    // the heartbeat, ZADD extends pending. A transposition would either
    // orphan the claim (HDEL before HGET) or leak the heartbeat.
    const src = REQUEUE_FOR_RESUME_SCRIPT;
    const hgetIdx = src.indexOf('HGET');
    const hdelIdx = src.indexOf('HDEL');
    const delIdx = src.indexOf('DEL', hdelIdx + 1); // skip 'HDEL'
    const zaddIdx = src.indexOf('ZADD');
    expect(hgetIdx, 'HGET must be present').toBeGreaterThanOrEqual(0);
    expect(hdelIdx, 'HDEL must be after HGET').toBeGreaterThan(hgetIdx);
    expect(delIdx, 'DEL heartbeat must be after HDEL').toBeGreaterThan(hdelIdx);
    expect(zaddIdx, 'ZADD must be after HDEL').toBeGreaterThan(hdelIdx);
  });

  it('HGET checks KEYS[2] (claimed hash) with the itemKey ARGV[1]', () => {
    expect(REQUEUE_FOR_RESUME_SCRIPT).toMatch(
      /HGET'?\s*,\s*KEYS\[2\]\s*,\s*ARGV\[1\]/,
    );
  });

  it('HDEL writes to KEYS[2] (claimed hash) with the itemKey ARGV[1]', () => {
    expect(REQUEUE_FOR_RESUME_SCRIPT).toMatch(
      /HDEL'?\s*,\s*KEYS\[2\]\s*,\s*ARGV\[1\]/,
    );
  });

  it('DEL clears KEYS[3] (heartbeat) on both branches', () => {
    // The null-guard branch and the happy branch both fire DEL on KEYS[3].
    const matches = [...REQUEUE_FOR_RESUME_SCRIPT.matchAll(
      /DEL'?\s*,\s*KEYS\[3\]/g,
    )];
    expect(matches.length, 'DEL heartbeat must fire on both branches').toBe(2);
  });

  it('ZADD writes to KEYS[1] (pending) with resumePriority ARGV[2]', () => {
    expect(REQUEUE_FOR_RESUME_SCRIPT).toMatch(
      /ZADD'?\s*,\s*KEYS\[1\]\s*,\s*tonumber\(ARGV\[2\]\)/,
    );
  });

  it('returns tuple {0, -1} on the null-guard branch and {1, N} on the happy branch', () => {
    // FR-005 tuple return shape. The null-guard fires BEFORE the mutation
    // block, so `{0, -1}` must appear textually before `{1,`.
    const src = REQUEUE_FOR_RESUME_SCRIPT;
    const nullGuardIdx = src.indexOf('{0, -1}');
    const happyIdx = src.search(/\{1,\s*parsed\.attemptCount\}/);
    expect(nullGuardIdx, '{0, -1} present').toBeGreaterThanOrEqual(0);
    expect(happyIdx, '{1, parsed.attemptCount} present').toBeGreaterThan(nullGuardIdx);
  });

  it('preserves parsed.attemptCount verbatim (FR-003 — do NOT increment)', () => {
    // Load-bearing assertion: any refactor that changes this to
    // `parsed.attemptCount + 1` would silently condemn blameless items
    // to dead-letter after N lease-expiry events.
    expect(REQUEUE_FOR_RESUME_SCRIPT).toMatch(
      /base\.attemptCount\s*=\s*parsed\.attemptCount(?!\s*\+)/,
    );
  });

  it('strips claimedAt (A6) so the next claim stamps a fresh one', () => {
    expect(REQUEUE_FOR_RESUME_SCRIPT).toMatch(/base\.claimedAt\s*=\s*nil/);
  });
});

describe('RedisQueueAdapter — RELEASE_SCRIPT text (#1069 script-wiring assertions)', () => {
  it('script contains HGET, HDEL, DEL, ZADD, SREM (dead-letter branch)', () => {
    const src = RELEASE_SCRIPT;
    expect(src.indexOf('HGET'), 'HGET present').toBeGreaterThanOrEqual(0);
    expect(src.indexOf('HDEL'), 'HDEL present').toBeGreaterThanOrEqual(0);
    expect(src.indexOf('DEL'), 'DEL present').toBeGreaterThanOrEqual(0);
    expect(src.indexOf('ZADD'), 'ZADD present').toBeGreaterThanOrEqual(0);
    // FR-006 — SREM fires ONLY on the dead-letter branch.
    expect(src.indexOf('SREM'), 'SREM present (dead-letter branch)').toBeGreaterThanOrEqual(0);
  });

  it('HGET reads KEYS[2] (claimed hash) with ARGV[1]', () => {
    expect(RELEASE_SCRIPT).toMatch(/HGET'?\s*,\s*KEYS\[2\]\s*,\s*ARGV\[1\]/);
  });

  it('retry branch writes to KEYS[1] (pending) with retryPriority ARGV[2]', () => {
    expect(RELEASE_SCRIPT).toMatch(
      /ZADD'?\s*,\s*KEYS\[1\]\s*,\s*tonumber\(ARGV\[2\]\)/,
    );
  });

  it('dead-letter branch writes to KEYS[4] (dead-letter ZSET) with score ARGV[5]', () => {
    expect(RELEASE_SCRIPT).toMatch(
      /ZADD'?\s*,\s*KEYS\[4\]\s*,\s*tonumber\(ARGV\[5\]\)/,
    );
  });

  it('SREM removes from KEYS[5] (in-flight SET) — FR-006 dead-letter branch only', () => {
    expect(RELEASE_SCRIPT).toMatch(
      /SREM'?\s*,\s*KEYS\[5\]\s*,\s*ARGV\[1\]/,
    );
  });

  it('increments attemptCount by exactly one on the retry side (FR-004)', () => {
    expect(RELEASE_SCRIPT).toMatch(
      /attemptCount\s*=\s*parsed\.attemptCount\s*\+\s*1/,
    );
  });

  it('dispatches on attemptCount >= tonumber(ARGV[4]) (maxRetries threshold)', () => {
    expect(RELEASE_SCRIPT).toMatch(
      /attemptCount\s*>=\s*maxRetries/,
    );
  });

  it('returns tuple {0, -1} on null-guard, {1, N} on retry, {2, N} on dead-letter', () => {
    // The three FR-005 return shapes, in the order they appear textually
    // in the script body: null-guard first, then dead-letter (`if` block),
    // then retry (fall-through). A regression that swapped {1, N} and
    // {2, N} would silently retry-after-dead-letter or vice versa.
    const src = RELEASE_SCRIPT;
    const nullGuardIdx = src.indexOf('{0, -1}');
    const deadLetterIdx = src.indexOf('{2,');
    const retryIdx = src.indexOf('{1,');
    expect(nullGuardIdx, '{0, -1} present').toBeGreaterThanOrEqual(0);
    expect(deadLetterIdx, '{2, N} present').toBeGreaterThan(nullGuardIdx);
    expect(retryIdx, '{1, N} present').toBeGreaterThan(deadLetterIdx);
  });

  it('strips claimedAt (A6) so the next claim stamps a fresh one', () => {
    expect(RELEASE_SCRIPT).toMatch(/base\.claimedAt\s*=\s*nil/);
  });
});

describe('RedisQueueAdapter — defineCommand wiring for new scripts (#1069)', () => {
  function createMinimalMockRedisForNewScripts(): {
    redis: unknown;
    defineCommand: ReturnType<typeof vi.fn>;
    requeueForResumeItem: ReturnType<typeof vi.fn>;
    releaseItem: ReturnType<typeof vi.fn>;
  } {
    const defineCommand = vi.fn();
    // Return the {code, attemptCount} tuple both scripts emit.
    const requeueForResumeItem = vi.fn().mockResolvedValue([1, 5]);
    const releaseItem = vi.fn().mockResolvedValue([1, 3]);
    const redis: Record<string, unknown> = {
      defineCommand,
      requeueForResumeItem,
      releaseItem,
      hget: vi.fn().mockResolvedValue(null),
      hdel: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
      zadd: vi.fn().mockResolvedValue(1),
    };
    return { redis, defineCommand, requeueForResumeItem, releaseItem };
  }

  function makeAdapter(redis: unknown) {
    return new RedisQueueAdapter(redis as import('ioredis').Redis, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    });
  }

  const sampleQueueItem: QueueItem = {
    owner: 'generacy-ai',
    repo: 'generacy',
    issueNumber: 1069,
    workflowName: 'speckit-feature',
    command: 'process',
    priority: 1000,
    enqueuedAt: new Date().toISOString(),
    queueReason: 'new',
  };

  it('defineCommand("requeueForResumeItem", { numberOfKeys: 3, lua: REQUEUE_FOR_RESUME_SCRIPT })', async () => {
    const { redis, defineCommand } = createMinimalMockRedisForNewScripts();
    const adapter = makeAdapter(redis);
    await adapter.requeueForResume('worker-1', sampleQueueItem);
    expect(defineCommand).toHaveBeenCalledWith('requeueForResumeItem', {
      numberOfKeys: 3,
      lua: REQUEUE_FOR_RESUME_SCRIPT,
    });
  });

  it('defineCommand("releaseItem", { numberOfKeys: 5, lua: RELEASE_SCRIPT })', async () => {
    const { redis, defineCommand } = createMinimalMockRedisForNewScripts();
    const adapter = makeAdapter(redis);
    await adapter.release('worker-1', sampleQueueItem);
    expect(defineCommand).toHaveBeenCalledWith('releaseItem', {
      numberOfKeys: 5,
      lua: RELEASE_SCRIPT,
    });
  });

  it('requeueForResume() invokes requeueForResumeItem with 6 args (3 keys + 3 argv)', async () => {
    const { redis, requeueForResumeItem } = createMinimalMockRedisForNewScripts();
    const adapter = makeAdapter(redis);
    await adapter.requeueForResume('worker-1', sampleQueueItem);
    expect(requeueForResumeItem).toHaveBeenCalledOnce();
    expect(requeueForResumeItem.mock.calls[0]).toHaveLength(6);
    // KEYS[1..3]
    expect(requeueForResumeItem.mock.calls[0][0]).toBe('orchestrator:queue:pending');
    expect(requeueForResumeItem.mock.calls[0][1]).toBe('orchestrator:queue:claimed:worker-1');
    expect(requeueForResumeItem.mock.calls[0][2]).toBe('orchestrator:worker:worker-1:heartbeat');
    // ARGV[1] = itemKey
    expect(requeueForResumeItem.mock.calls[0][3]).toBe('generacy-ai/generacy#1069');
  });

  it('release() invokes releaseItem with 10 args (5 keys + 5 argv)', async () => {
    const { redis, releaseItem } = createMinimalMockRedisForNewScripts();
    const adapter = makeAdapter(redis);
    await adapter.release('worker-1', sampleQueueItem);
    expect(releaseItem).toHaveBeenCalledOnce();
    expect(releaseItem.mock.calls[0]).toHaveLength(10);
    // KEYS[1..5]
    expect(releaseItem.mock.calls[0][0]).toBe('orchestrator:queue:pending');
    expect(releaseItem.mock.calls[0][1]).toBe('orchestrator:queue:claimed:worker-1');
    expect(releaseItem.mock.calls[0][2]).toBe('orchestrator:worker:worker-1:heartbeat');
    expect(releaseItem.mock.calls[0][3]).toBe('orchestrator:queue:dead-letter');
    expect(releaseItem.mock.calls[0][4]).toBe('orchestrator:queue:in-flight-items');
    // ARGV[1] = itemKey
    expect(releaseItem.mock.calls[0][5]).toBe('generacy-ai/generacy#1069');
  });
});
