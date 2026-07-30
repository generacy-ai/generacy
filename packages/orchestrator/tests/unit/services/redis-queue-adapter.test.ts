import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RedisQueueAdapter } from '../../../src/services/redis-queue-adapter.js';
import type { QueueItem, SerializedQueueItem } from '../../../src/types/index.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function createMockRedis(overrides: Record<string, unknown> = {}) {
  const mock: Record<string, unknown> = {
    zadd: vi.fn().mockResolvedValue(1),
    zcard: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue([]),
    hget: vi.fn().mockResolvedValue(null),
    hdel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    hlen: vi.fn().mockResolvedValue(0),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    sismember: vi.fn().mockResolvedValue(0),
    scan: vi.fn().mockResolvedValue(['0', []]),
    defineCommand: vi.fn(),
    claimItem: vi.fn().mockResolvedValue(null),
    // #1060 PR #1065 review findings 5+6 — enqueue() and enqueueIfAbsent()
    // share the single `enqueueIfAbsent` command (byte-identical Lua, one
    // registration). The previously-separate `enqueueItem` command was
    // deleted; regressing would require re-adding it.
    enqueueIfAbsent: vi.fn().mockResolvedValue(1),
    // #1069 — release() and requeueForResume() moved read-then-mutate
    // sequences into Lua scripts registered via defineCommand. Both return
    // Lua array tuples [code, attemptCount]. Default returns model the
    // retry-branch happy path so unrelated call sites don't have to know
    // about them; tests that need dead-letter (code=2) or reaper-race
    // (code=0) override.
    releaseItem: vi.fn().mockResolvedValue([1, 1]),
    requeueForResumeItem: vi.fn().mockResolvedValue([1, 0]),
    ...overrides,
  };
  // Chainable multi() that forwards to the underlying fns and returns [null, res] tuples on exec.
  mock['multi'] = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    const queued: Promise<unknown>[] = [];
    const forward = (name: string) => (...args: unknown[]) => {
      const fn = mock[name] as (...a: unknown[]) => Promise<unknown>;
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
  return mock as unknown as import('ioredis').Redis;
}

const sampleItem: QueueItem = {
  owner: 'test-org',
  repo: 'test-repo',
  issueNumber: 42,
  workflowName: 'speckit-feature',
  command: 'process',
  priority: 1000,
  enqueuedAt: '2024-01-01T00:00:00Z',
};

function buildSerializedItem(
  item: QueueItem,
  attemptCount = 0
): SerializedQueueItem {
  return {
    ...item,
    attemptCount,
    itemKey: `${item.owner}/${item.repo}#${item.issueNumber}`,
  };
}

describe('RedisQueueAdapter', () => {
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
  });

  describe('enqueue', () => {
    it('should invoke enqueueIfAbsent command with correct itemKey, priority, and serialized payload (#1060, PR #1065 findings 5+6)', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.enqueue(sampleItem);
      expect(result).toBe(true);

      // 2 keys (pending + in-flight) + 3 argv (itemKey + priority + payload).
      // NOT the deleted 3-key `enqueueItem` variant (finding 5: CROSSSLOT-safe).
      expect(redis.enqueueIfAbsent).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        'orchestrator:queue:in-flight-items',
        'test-org/test-repo#42',
        expect.any(String),
        expect.any(String),
      );

      // Verify the serialized payload includes attemptCount and itemKey.
      const serializedArg = (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock
        .calls[0][4] as string;
      const parsed = JSON.parse(serializedArg) as SerializedQueueItem;
      expect(parsed.attemptCount).toBe(0);
      expect(parsed.itemKey).toBe('test-org/test-repo#42');
      expect(parsed.owner).toBe('test-org');
      expect(parsed.repo).toBe('test-repo');
      expect(parsed.issueNumber).toBe(42);
      expect(parsed.workflowName).toBe('speckit-feature');
      expect(parsed.command).toBe('process');
      expect(typeof parsed.priority).toBe('number');
      expect(parsed.enqueuedAt).toBe('2024-01-01T00:00:00Z');
    });

    it('should log info on successful enqueue', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue(sampleItem);

      expect(logger.info).toHaveBeenCalledWith(
        {
          owner: 'test-org',
          repo: 'test-repo',
          issue: 42,
          priority: expect.any(Number),
          itemKey: 'test-org/test-repo#42',
        },
        'Item enqueued to Redis sorted set (in-flight-checked)'
      );
    });

    it('should THROW on Redis error (PR #1065 review finding 4 — must not conflate transport error with in-flight drop)', async () => {
      const redis = createMockRedis({
        enqueueIfAbsent: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      // Contract change: rethrow instead of swallow. Callers on the
      // intake path (label-monitor-service) need to distinguish "already
      // in flight" (safe to markProcessed for dedup) from "transport
      // error" (must NOT markProcessed — the next poll must retry).
      await expect(adapter.enqueue(sampleItem)).rejects.toThrow('Connection refused');
    });

    it('should return false when enqueueIfAbsent reports item already in flight', async () => {
      const redis = createMockRedis({
        enqueueIfAbsent: vi.fn().mockResolvedValue(0),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.enqueue(sampleItem);
      expect(result).toBe(false);
    });
  });

  describe('release — reaper-race null-guard (#1060 PR #1065 review finding 1)', () => {
    it('should NOT re-pend to ZSET when claim hash is already gone (reaper HDEL raced)', async () => {
      // #1069 — the read-then-mutate sequence moved into Lua. The reaper
      // race is now signalled by RELEASE_SCRIPT returning tuple {0, -1}
      // instead of the pre-#1069 `HGET → null` path. The invariant is
      // identical: on the reaper-race branch, no pending member is added
      // (script bails before its ZADD). Structured info log fires with the
      // race-path message. This hermetic mirror complements the real-Redis
      // suite (redis-queue-adapter.release-atomic.test.ts) which exercises
      // the actual script body.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([0, -1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // Zero ZADDs from the JS surface — dead-letter/pending writes now
      // happen INSIDE Lua on codes 1/2. Code 0 does neither by design.
      expect(redis.zadd).not.toHaveBeenCalled();
      // Structured log line for the race path (SC-002 observability).
      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42' },
        'release() called on already-cleared claim (reaper race) — skipping re-pend to avoid duplicate pending member',
      );
    });
  });

  describe('requeueForResume (#1060 PR #1065 review finding 2)', () => {
    // #1069 — the read-then-mutate sequence moved into REQUEUE_FOR_RESUME_SCRIPT.
    // Return contract: [code, attemptCount]. Code 0 = reaper-race no-op;
    // code 1 = re-pended at resume priority; there is NO code 2 for this
    // script (FR-003: lease expiry never dead-letters). Behaviour that the
    // pre-#1069 code covered via JS-side hget+multi assertions is now
    // covered by direct assertion on the command's ARGV and by the log
    // lines the adapter emits based on the returned code. The real script
    // body's ZADD-not-SREM invariants and dead-letter-vs-retry contract
    // are pinned by the real-Redis suite in
    // src/services/__tests__/redis-queue-adapter.requeueForResume-atomic.test.ts
    // and by the script-text assertions in redis-queue-adapter.script-wiring.test.ts.
    // These hermetic doubles guard the JS-side dispatch on those tuple codes.

    it('should invoke requeueForResumeItem with 3 keys + itemKey + resumePriority + serialized item', async () => {
      const redis = createMockRedis({
        requeueForResumeItem: vi.fn().mockResolvedValue([1, 2]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.requeueForResume('worker-1', sampleItem);

      // KEYS[1]=pending, KEYS[2]=claimed:<worker>, KEYS[3]=heartbeat:<worker>.
      // ARGV[1]=itemKey, ARGV[2]=resumePriority (stringified), ARGV[3]=JSON item.
      // Resume priority is the 0.x tier so the script body ZADDs a fresh
      // pending member at the highest-priority score.
      expect(redis.requeueForResumeItem).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        'orchestrator:queue:claimed:worker-1',
        'orchestrator:worker:worker-1:heartbeat',
        'test-org/test-repo#42',
        expect.any(String),
        expect.any(String),
      );
      const resumePriorityArg = Number(
        (redis.requeueForResumeItem as ReturnType<typeof vi.fn>).mock.calls[0][4] as string,
      );
      expect(resumePriorityArg).toBeGreaterThan(0);
      expect(resumePriorityArg).toBeLessThan(1);
    });

    it('should log info with preserved attemptCount and reason=lease-expiry on the re-pend branch (code 1)', async () => {
      // Preserve attemptCount verbatim: lease expiry is an infrastructure
      // event and MUST NOT count toward dead-letter (default maxRetries=3).
      // Script returned attemptCount=2 (unmodified from the claim payload)
      // and adapter surfaces it in the info line.
      const redis = createMockRedis({
        requeueForResumeItem: vi.fn().mockResolvedValue([1, 2]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.requeueForResume('worker-1', sampleItem);

      expect(logger.info).toHaveBeenCalledWith(
        {
          workerId: 'worker-1',
          itemKey: 'test-org/test-repo#42',
          attemptCount: 2,
          reason: 'lease-expiry',
        },
        'Item re-pended at resume priority (attemptCount preserved)',
      );
    });

    it('should NEVER dead-letter, even at attemptCount that would normally dead-letter via release()', async () => {
      // Contract enforcement (hermetic mirror of the real-Redis assertion
      // in redis-queue-adapter.requeueForResume-atomic.test.ts): three
      // lease expiries on the same item must not accumulate into
      // dead-letter. `requeueForResumeItem` has no dead-letter branch by
      // construction — it returns tuple codes {0, 1} only, never 2. This
      // test locks that dispatch surface: no code path in the adapter
      // maps a requeueForResume outcome to dead-letter, so even a return
      // of [1, 99] logs the info line and never mutates dead-letter.
      const redis = createMockRedis({
        requeueForResumeItem: vi.fn().mockResolvedValue([1, 99]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.requeueForResume('worker-1', sampleItem);

      // No JS-surface ZADD to dead-letter — the adapter cannot even
      // route to that branch on a requeueForResume outcome.
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      // Info line still surfaces the (unmodified) attemptCount.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ attemptCount: 99, reason: 'lease-expiry' }),
        'Item re-pended at resume priority (attemptCount preserved)',
      );
    });

    it('should log the reaper-race info line when script returns code 0 (same reaper race as release())', async () => {
      const redis = createMockRedis({
        requeueForResumeItem: vi.fn().mockResolvedValue([0, -1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.requeueForResume('worker-1', sampleItem);

      // No dispatch-side mutation on the race path.
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42' },
        'requeueForResume() called on already-cleared claim (reaper race) — skipping re-pend',
      );
    });

    it('should preserve in-flight-SET membership at the dispatch layer (never SREM from JS)', async () => {
      // The item was and remains in flight (only its claim moves back to
      // pending). SREM would break the in-flight = pending ∪ claimed
      // invariant that #1060 exists to enforce. #1069 moved all mutation
      // into Lua; the script never SREMs on the requeueForResume path,
      // and the JS dispatch layer has no SREM call at all. This assertion
      // guards the dispatch layer; the real-Redis suite guards the script
      // body's actual set contents.
      const redis = createMockRedis({
        requeueForResumeItem: vi.fn().mockResolvedValue([1, 0]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.requeueForResume('worker-1', sampleItem);

      expect(redis.srem).not.toHaveBeenCalled();
    });
  });

  describe('claim', () => {
    it('should define the claimItem command on first call', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.claim('worker-1');

      expect(redis.defineCommand).toHaveBeenCalledWith('claimItem', {
        numberOfKeys: 3,
        lua: expect.any(String),
      });
    });

    it('should only define claimItem command once', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.claim('worker-1');
      await adapter.claim('worker-2');

      expect(redis.defineCommand).toHaveBeenCalledTimes(1);
    });

    it('should return deserialized QueueItem when queue has items', async () => {
      const serialized = buildSerializedItem(sampleItem, 0);
      const redis = createMockRedis({
        claimItem: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.claim('worker-1');

      expect(result).toEqual({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        workflowName: 'speckit-feature',
        command: 'process',
        priority: 1000,
        enqueuedAt: '2024-01-01T00:00:00Z',
        metadata: undefined,
      });
    });

    it('should preserve metadata through claim', async () => {
      const itemWithMeta: QueueItem = {
        ...sampleItem,
        metadata: { prNumber: 7, reviewThreadIds: [1, 2] },
      };
      const serialized = buildSerializedItem(itemWithMeta, 0);
      const redis = createMockRedis({
        claimItem: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.claim('worker-1');

      expect(result).not.toBeNull();
      expect(result!.metadata).toEqual({ prNumber: 7, reviewThreadIds: [1, 2] });
    });

    it('should call claimItem with correct keys, TTL, and claimedAt (#1054 finding 3)', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.claim('worker-1');

      // #1054 finding 3 — CLAIM_SCRIPT stamps a fresh ISO-8601 claimedAt
      // (ARGV[2]) so the reaper's grace-window measures age-since-CLAIM.
      expect(
        (redis as any).claimItem
      ).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        'orchestrator:queue:claimed:worker-1',
        'orchestrator:worker:worker-1:heartbeat',
        30, // Math.ceil(30000 / 1000)
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      );
    });

    it('should return null when queue is empty', async () => {
      const redis = createMockRedis({
        claimItem: vi.fn().mockResolvedValue(null),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.claim('worker-1');

      expect(result).toBeNull();
    });

    it('should log info with workerId and itemKey on successful claim', async () => {
      const serialized = buildSerializedItem(sampleItem, 1);
      const redis = createMockRedis({
        claimItem: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.claim('worker-1');

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42', attempt: 1 },
        'Item claimed from queue'
      );
    });

    it('should return null and log warning on Redis error', async () => {
      const redis = createMockRedis({
        claimItem: vi.fn().mockRejectedValue(new Error('NOSCRIPT')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const result = await adapter.claim('worker-1');

      expect(result).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), workerId: 'worker-1' },
        'Redis error in claim, returning null'
      );
    });
  });

  describe('release', () => {
    // #1069 — the read-then-mutate (HGET + client-side MULTI: HDEL/DEL/ZADD)
    // moved into RELEASE_SCRIPT registered via defineCommand as `releaseItem`.
    // Return contract: [code, attemptCount] tuple. code 0 = reaper-race
    // no-op ({0, -1}); code 1 = retry re-pended with attemptCount = parsed
    // + 1; code 2 = dead-lettered with attemptCount = parsed + 1. The JS
    // dispatch layer switches on code and emits the pre-existing log-line
    // shapes verbatim (FR-005 / SC-007). Behaviour previously covered via
    // JS-side ZADD-target assertions is now covered by:
    //   - direct assertion on `releaseItem`'s KEYS + ARGV here (script
    //     receives the right inputs)
    //   - assertion on the log-line the adapter emits per returned code
    //     (dispatch layer routes correctly)
    // The real script body's HDEL/DEL/ZADD/SREM sequencing is pinned by
    // the real-Redis suite in
    // src/services/__tests__/redis-queue-adapter.release-atomic.test.ts
    // and by the script-text assertions in redis-queue-adapter.script-wiring.test.ts.

    it('should invoke releaseItem with 5 keys + itemKey + retryPriority + item + maxRetries + deadLetterScore', async () => {
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([1, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // KEYS[1]=pending, KEYS[2]=claimed:<worker>, KEYS[3]=heartbeat:<worker>,
      // KEYS[4]=dead-letter, KEYS[5]=in-flight-items. ARGV[1]=itemKey,
      // ARGV[2]=retryPriority (stringified), ARGV[3]=JSON item,
      // ARGV[4]=maxRetries (stringified), ARGV[5]=dead-letter score
      // (Date.now(), stringified). Any drift here — a key reorder, a
      // dropped argv — would fail the real-Redis script call too, but
      // this hermetic check is cheap and gives a clean diff on regression.
      expect(redis.releaseItem).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        'orchestrator:queue:claimed:worker-1',
        'orchestrator:worker:worker-1:heartbeat',
        'orchestrator:queue:dead-letter',
        'orchestrator:queue:in-flight-items',
        'test-org/test-repo#42',
        expect.any(String),
        expect.any(String),
        '3',
        expect.any(String),
      );
      // Retry priority is the 1.x tier.
      const retryPriorityArg = Number(
        (redis.releaseItem as ReturnType<typeof vi.fn>).mock.calls[0][6] as string,
      );
      expect(retryPriorityArg).toBeGreaterThan(1);
      expect(retryPriorityArg).toBeLessThan(2);
    });

    it('should log info with incremented attemptCount on the retry branch (code 1)', async () => {
      // Script returned attemptCount=1 (parsed + 1 where parsed=0). Adapter
      // surfaces it verbatim in the info line — same shape as pre-#1069.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([1, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42', attemptCount: 1 },
        'Item released back to pending queue',
      );
    });

    it('should NOT re-queue when script signals reaper-race no-op (code 0)', async () => {
      // Pre-#1069: adapter did an HGET, saw null, bailed. Now RELEASE_SCRIPT
      // does the HGET inside Lua, returns {0, -1}, and the adapter's
      // dispatch layer routes to the race-path info log. The invariant
      // (no duplicate pending member) is proven end-to-end in the
      // real-Redis suite; this test locks that the dispatch does not
      // emit a spurious dead-letter warn on code 0.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([0, -1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      expect(redis.zadd).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should log dead-letter warn on code 2, at attemptCount surfaced by script', async () => {
      // Default maxRetries is 3. The script decides dead-letter internally
      // (attemptCount >= maxRetries after the parsed+1 bump) and returns
      // {2, N}. Adapter surfaces N in the warn line and does not compute
      // it JS-side.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([2, 3]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // No JS-side ZADD to dead-letter — that happens inside Lua now.
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        {
          workerId: 'worker-1',
          itemKey: 'test-org/test-repo#42',
          attemptCount: 3,
          maxRetries: 3,
        },
        'Item dead-lettered after max retries',
      );
    });

    it('should pass custom maxRetries through ARGV[4] so the script threshold changes', async () => {
      // Behaviourally verified end-to-end by the real-Redis suite; here
      // we confirm the adapter forwards the configured `maxRetries` to
      // Lua as ARGV[4] so the script's `if attemptCount >= maxRetries`
      // gate uses the right threshold.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([2, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger, { maxRetries: 1 });

      await adapter.release('worker-1', sampleItem);

      const argvMaxRetries = (redis.releaseItem as ReturnType<typeof vi.fn>).mock.calls[0][8];
      expect(argvMaxRetries).toBe('1');
    });

    it('should gracefully degrade on Redis error', async () => {
      const redis = createMockRedis({
        releaseItem: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      // Should not throw
      await adapter.release('worker-1', sampleItem);

      expect(logger.warn).toHaveBeenCalledWith(
        {
          err: expect.any(Error),
          workerId: 'worker-1',
          itemKey: 'test-org/test-repo#42',
        },
        'Redis error in release'
      );
    });
  });

  describe('complete', () => {
    it('should remove claimed item and heartbeat', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.complete('worker-1', sampleItem);

      expect(redis.hdel).toHaveBeenCalledWith(
        'orchestrator:queue:claimed:worker-1',
        'test-org/test-repo#42'
      );
      expect(redis.del).toHaveBeenCalledWith(
        'orchestrator:worker:worker-1:heartbeat'
      );
    });

    it('should log info on successful completion', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.complete('worker-1', sampleItem);

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42' },
        'Item completed and removed from claimed set + in-flight index'
      );
    });

    it('should gracefully degrade on Redis error', async () => {
      const redis = createMockRedis({
        hdel: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      // Should not throw
      await adapter.complete('worker-1', sampleItem);

      expect(logger.warn).toHaveBeenCalledWith(
        {
          err: expect.any(Error),
          workerId: 'worker-1',
          itemKey: 'test-org/test-repo#42',
        },
        'Redis error in complete'
      );
    });
  });

  describe('getQueueDepth', () => {
    it('should return ZCARD result', async () => {
      const redis = createMockRedis({
        zcard: vi.fn().mockResolvedValue(7),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const depth = await adapter.getQueueDepth();

      expect(depth).toBe(7);
      expect(redis.zcard).toHaveBeenCalledWith('orchestrator:queue:pending');
    });

    it('should return 0 when queue is empty', async () => {
      const redis = createMockRedis({
        zcard: vi.fn().mockResolvedValue(0),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const depth = await adapter.getQueueDepth();

      expect(depth).toBe(0);
    });

    it('should return 0 and log warning on Redis error', async () => {
      const redis = createMockRedis({
        zcard: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const depth = await adapter.getQueueDepth();

      expect(depth).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Redis error in getQueueDepth'
      );
    });
  });

  describe('getQueueItems', () => {
    it('should return deserialized items with scores', async () => {
      const item1 = buildSerializedItem(sampleItem, 0);
      const item2 = buildSerializedItem(
        { ...sampleItem, issueNumber: 99, priority: 2000 },
        1
      );
      const redis = createMockRedis({
        zrange: vi.fn().mockResolvedValue([
          JSON.stringify(item1),
          '1000',
          JSON.stringify(item2),
          '2000',
        ]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const items = await adapter.getQueueItems(0, 10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        item: {
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 42,
          workflowName: 'speckit-feature',
          command: 'process',
          priority: 1000,
          enqueuedAt: '2024-01-01T00:00:00Z',
          metadata: undefined,
        },
        score: 1000,
      });
      expect(items[1]).toEqual({
        item: {
          owner: 'test-org',
          repo: 'test-repo',
          issueNumber: 99,
          workflowName: 'speckit-feature',
          command: 'process',
          priority: 2000,
          enqueuedAt: '2024-01-01T00:00:00Z',
          metadata: undefined,
        },
        score: 2000,
      });
    });

    it('should preserve metadata through getQueueItems', async () => {
      const itemWithMeta: QueueItem = {
        ...sampleItem,
        metadata: { description: 'Test issue body' },
      };
      const serialized = buildSerializedItem(itemWithMeta, 0);
      const redis = createMockRedis({
        zrange: vi.fn().mockResolvedValue([
          JSON.stringify(serialized),
          '1000',
        ]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const items = await adapter.getQueueItems(0, 10);

      expect(items).toHaveLength(1);
      expect(items[0].item.metadata).toEqual({ description: 'Test issue body' });
    });

    it('should call ZRANGE with correct offset and limit', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.getQueueItems(5, 10);

      expect(redis.zrange).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        5,
        14, // offset + limit - 1
        'WITHSCORES'
      );
    });

    it('should return empty array when queue is empty', async () => {
      const redis = createMockRedis({
        zrange: vi.fn().mockResolvedValue([]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const items = await adapter.getQueueItems(0, 10);

      expect(items).toEqual([]);
    });

    it('should strip internal fields from returned items', async () => {
      const serialized = buildSerializedItem(sampleItem, 2);
      const redis = createMockRedis({
        zrange: vi.fn().mockResolvedValue([
          JSON.stringify(serialized),
          '1000',
        ]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const items = await adapter.getQueueItems(0, 10);

      // Should not contain attemptCount or itemKey in the returned item
      const returnedItem = items[0].item;
      expect(returnedItem).not.toHaveProperty('attemptCount');
      expect(returnedItem).not.toHaveProperty('itemKey');
    });

    it('should return empty array and log warning on Redis error', async () => {
      const redis = createMockRedis({
        zrange: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const items = await adapter.getQueueItems(0, 10);

      expect(items).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Redis error in getQueueItems'
      );
    });
  });

  describe('getActiveWorkerCount', () => {
    it('should return 0 when no claimed keys exist', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue(['0', []]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const count = await adapter.getActiveWorkerCount();

      expect(count).toBe(0);
      expect(redis.scan).toHaveBeenCalledWith(
        '0',
        'MATCH',
        'orchestrator:queue:claimed:*',
        'COUNT',
        100
      );
    });

    it('should sum hlen across all claimed keys', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockResolvedValue([
          '0',
          [
            'orchestrator:queue:claimed:worker-1',
            'orchestrator:queue:claimed:worker-2',
          ],
        ]),
        hlen: vi
          .fn()
          .mockResolvedValueOnce(2)
          .mockResolvedValueOnce(1),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const count = await adapter.getActiveWorkerCount();

      expect(count).toBe(3);
      expect(redis.hlen).toHaveBeenCalledWith(
        'orchestrator:queue:claimed:worker-1'
      );
      expect(redis.hlen).toHaveBeenCalledWith(
        'orchestrator:queue:claimed:worker-2'
      );
    });

    it('should handle multi-page scan cursor iteration', async () => {
      const redis = createMockRedis({
        scan: vi
          .fn()
          .mockResolvedValueOnce([
            '42', // non-zero cursor means more pages
            ['orchestrator:queue:claimed:worker-1'],
          ])
          .mockResolvedValueOnce([
            '0', // cursor 0 means done
            ['orchestrator:queue:claimed:worker-2'],
          ]),
        hlen: vi
          .fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(3),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const count = await adapter.getActiveWorkerCount();

      expect(count).toBe(4);
      expect(redis.scan).toHaveBeenCalledTimes(2);
    });

    it('should return 0 and log warning on Redis error', async () => {
      const redis = createMockRedis({
        scan: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      const count = await adapter.getActiveWorkerCount();

      expect(count).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        'Redis error in getActiveWorkerCount'
      );
    });
  });

  describe('queue priority', () => {
    it('should enqueue resume items with 0.x priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue({ ...sampleItem, queueReason: 'resume' });

      // #1060 PR #1065 findings 5+6: enqueue routes through the shared
      // enqueueIfAbsent command (2 keys + 3 argv → priority at index 3).
      const score = Number(
        (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][3] as string,
      );
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it('should enqueue retry items with 1.x priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue({ ...sampleItem, queueReason: 'retry' });

      const score = Number(
        (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][3] as string,
      );
      expect(score).toBeGreaterThan(1);
      expect(score).toBeLessThan(2);
    });

    it('should enqueue new items with Date.now() priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      const before = Date.now();
      await adapter.enqueue({ ...sampleItem, queueReason: 'new' });
      const after = Date.now();

      const score = Number(
        (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][3] as string,
      );
      expect(score).toBeGreaterThanOrEqual(before);
      expect(score).toBeLessThanOrEqual(after);
    });

    it('should produce scores in order: resume < retry < new', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue({ ...sampleItem, issueNumber: 1, queueReason: 'resume' });
      await adapter.enqueue({ ...sampleItem, issueNumber: 2, queueReason: 'retry' });
      await adapter.enqueue({ ...sampleItem, issueNumber: 3, queueReason: 'new' });

      const scores = (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => Number(call[3] as string),
      );
      expect(scores[0]).toBeLessThan(scores[1]); // resume < retry
      expect(scores[1]).toBeLessThan(scores[2]); // retry < new
    });

    it('should set retry priority on release re-queue', async () => {
      // #1069 — the ZADD moved inside RELEASE_SCRIPT. The retry-priority
      // score is passed to Lua as ARGV[2] and the script's `ZADD KEYS[1],
      // tonumber(ARGV[2])` uses it. The adapter has to compute the score
      // JS-side either way (Lua can't call `getPriorityScore`), so we
      // assert on the string passed to the script.
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([1, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      const retryPriorityArgv = (redis.releaseItem as ReturnType<typeof vi.fn>).mock.calls[0][6] as string;
      const score = Number(retryPriorityArgv);
      // Retry priority is 1.{timestamp}
      expect(score).toBeGreaterThan(1);
      expect(score).toBeLessThan(2);
    });

    it('should default to Date.now() priority for items without queueReason (backwards compat)', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      const before = Date.now();
      await adapter.enqueue({ ...sampleItem }); // no queueReason
      const after = Date.now();

      const score = Number(
        (redis.enqueueIfAbsent as ReturnType<typeof vi.fn>).mock.calls[0][3] as string,
      );
      expect(score).toBeGreaterThanOrEqual(before);
      expect(score).toBeLessThanOrEqual(after);
    });
  });

  describe('constructor defaults', () => {
    // #1069 — the dead-letter-vs-retry decision moved inside RELEASE_SCRIPT.
    // Adapter forwards `maxRetries` to the script as ARGV[4] and the
    // script's `if attemptCount >= maxRetries` gate makes the decision.
    // The real end-to-end verification (that maxRetries=3 dead-letters
    // at attemptCount 3, and maxRetries=5 does not) lives in the
    // real-Redis suite at redis-queue-adapter.release-atomic.test.ts.
    // These hermetic tests lock the wiring from the JS constructor
    // default and the {maxRetries: N} option into the script's ARGV[4].

    it('should default maxRetries to 3 (forwarded to script as ARGV[4])', async () => {
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([1, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      const argvMaxRetries = (redis.releaseItem as ReturnType<typeof vi.fn>).mock.calls[0][8];
      expect(argvMaxRetries).toBe('3');
    });

    it('should allow custom maxRetries via config (forwarded to script as ARGV[4])', async () => {
      const redis = createMockRedis({
        releaseItem: vi.fn().mockResolvedValue([1, 1]),
      });
      const adapter = new RedisQueueAdapter(redis, logger, { maxRetries: 5 });

      await adapter.release('worker-1', sampleItem);

      const argvMaxRetries = (redis.releaseItem as ReturnType<typeof vi.fn>).mock.calls[0][8];
      expect(argvMaxRetries).toBe('5');
    });
  });
});
