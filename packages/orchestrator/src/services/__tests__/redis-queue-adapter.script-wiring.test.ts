import { describe, it, expect, vi } from 'vitest';
import {
  RedisQueueAdapter,
  _ENQUEUE_IF_ABSENT_SCRIPT_FOR_TESTS as ENQUEUE_IF_ABSENT_SCRIPT,
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
