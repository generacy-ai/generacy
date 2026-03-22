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
  return {
    zadd: vi.fn().mockResolvedValue(1),
    zcard: vi.fn().mockResolvedValue(0),
    zrange: vi.fn().mockResolvedValue([]),
    hget: vi.fn().mockResolvedValue(null),
    hdel: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    hlen: vi.fn().mockResolvedValue(0),
    scan: vi.fn().mockResolvedValue(['0', []]),
    defineCommand: vi.fn(),
    claimItem: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as import('ioredis').Redis;
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
    it('should add item to sorted set with correct priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue(sampleItem);

      expect(redis.zadd).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        expect.any(Number),
        expect.any(String)
      );

      // Verify the serialized payload includes attemptCount and itemKey
      const serializedArg = (redis.zadd as ReturnType<typeof vi.fn>).mock
        .calls[0][2] as string;
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
        },
        'Item enqueued to Redis sorted set'
      );
    });

    it('should log warning and not throw on Redis error', async () => {
      const redis = createMockRedis({
        zadd: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      // Should not throw
      await adapter.enqueue(sampleItem);

      expect(logger.warn).toHaveBeenCalledWith(
        { err: expect.any(Error), itemKey: 'test-org/test-repo#42' },
        'Redis error in enqueue, item not added to queue'
      );
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

    it('should call claimItem with correct keys and TTL', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.claim('worker-1');

      expect(
        (redis as any).claimItem
      ).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        'orchestrator:queue:claimed:worker-1',
        'orchestrator:worker:worker-1:heartbeat',
        30 // Math.ceil(30000 / 1000)
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
    it('should increment attemptCount and re-queue item', async () => {
      const serialized = buildSerializedItem(sampleItem, 0);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // Should clean up claimed hash and heartbeat
      expect(redis.hdel).toHaveBeenCalledWith(
        'orchestrator:queue:claimed:worker-1',
        'test-org/test-repo#42'
      );
      expect(redis.del).toHaveBeenCalledWith(
        'orchestrator:worker:worker-1:heartbeat'
      );

      // Should re-queue with retry priority
      expect(redis.zadd).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        expect.any(Number),
        expect.any(String)
      );

      const requeuedPayload = JSON.parse(
        (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
      ) as SerializedQueueItem;
      expect(requeuedPayload.attemptCount).toBe(1);
      expect(requeuedPayload.itemKey).toBe('test-org/test-repo#42');
      expect(requeuedPayload.queueReason).toBe('retry');
    });

    it('should re-queue with attemptCount 0 when no claimed data exists', async () => {
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(null),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // attemptCount starts at 0 when no claimed data, re-queued with retry priority
      expect(redis.zadd).toHaveBeenCalledWith(
        'orchestrator:queue:pending',
        expect.any(Number),
        expect.any(String)
      );

      const requeuedPayload = JSON.parse(
        (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][2] as string
      ) as SerializedQueueItem;
      expect(requeuedPayload.attemptCount).toBe(0);
      expect(requeuedPayload.queueReason).toBe('retry');
    });

    it('should move to dead-letter set after maxRetries exceeded', async () => {
      // Default maxRetries is 3, so attemptCount >= 3 should dead-letter
      const serialized = buildSerializedItem(sampleItem, 2); // will become 3 after increment
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      // Should NOT re-queue to pending
      const zaddCalls = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls;
      expect(zaddCalls).toHaveLength(1);
      expect(zaddCalls[0][0]).toBe('orchestrator:queue:dead-letter');

      // Verify dead-letter payload
      const deadLetterPayload = JSON.parse(zaddCalls[0][2] as string) as SerializedQueueItem;
      expect(deadLetterPayload.attemptCount).toBe(3);
      expect(deadLetterPayload.itemKey).toBe('test-org/test-repo#42');

      // Score should be Date.now() (timestamp)
      expect(typeof zaddCalls[0][1]).toBe('number');
    });

    it('should dead-letter when attemptCount exceeds custom maxRetries', async () => {
      const serialized = buildSerializedItem(sampleItem, 0); // will become 1 after increment
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger, { maxRetries: 1 });

      await adapter.release('worker-1', sampleItem);

      // With maxRetries=1 and attemptCount becoming 1, item should be dead-lettered
      const zaddCalls = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls;
      expect(zaddCalls).toHaveLength(1);
      expect(zaddCalls[0][0]).toBe('orchestrator:queue:dead-letter');
    });

    it('should log warning when dead-lettering', async () => {
      const serialized = buildSerializedItem(sampleItem, 2);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      expect(logger.warn).toHaveBeenCalledWith(
        {
          workerId: 'worker-1',
          itemKey: 'test-org/test-repo#42',
          attemptCount: 3,
          maxRetries: 3,
        },
        'Item dead-lettered after max retries'
      );
    });

    it('should log info when re-queuing', async () => {
      const serialized = buildSerializedItem(sampleItem, 0);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42', attemptCount: 1 },
        'Item released back to pending queue'
      );
    });

    it('should gracefully degrade on Redis error', async () => {
      const redis = createMockRedis({
        hget: vi.fn().mockRejectedValue(new Error('Connection refused')),
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
        'Item completed and removed from claimed set'
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

      const score = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it('should enqueue retry items with 1.x priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue({ ...sampleItem, queueReason: 'retry' });

      const score = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
      expect(score).toBeGreaterThan(1);
      expect(score).toBeLessThan(2);
    });

    it('should enqueue new items with Date.now() priority score', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      const before = Date.now();
      await adapter.enqueue({ ...sampleItem, queueReason: 'new' });
      const after = Date.now();

      const score = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
      expect(score).toBeGreaterThanOrEqual(before);
      expect(score).toBeLessThanOrEqual(after);
    });

    it('should produce scores in order: resume < retry < new', async () => {
      const redis = createMockRedis();
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.enqueue({ ...sampleItem, issueNumber: 1, queueReason: 'resume' });
      await adapter.enqueue({ ...sampleItem, issueNumber: 2, queueReason: 'retry' });
      await adapter.enqueue({ ...sampleItem, issueNumber: 3, queueReason: 'new' });

      const scores = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[1] as number
      );
      expect(scores[0]).toBeLessThan(scores[1]); // resume < retry
      expect(scores[1]).toBeLessThan(scores[2]); // retry < new
    });

    it('should set retry priority on release re-queue', async () => {
      const serialized = buildSerializedItem(sampleItem, 0);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      const score = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
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

      const score = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls[0][1] as number;
      expect(score).toBeGreaterThanOrEqual(before);
      expect(score).toBeLessThanOrEqual(after);
    });
  });

  describe('constructor defaults', () => {
    it('should default maxRetries to 3', async () => {
      // Verify default by releasing an item at attemptCount 2 (becomes 3 -> dead-letter)
      const serialized = buildSerializedItem(sampleItem, 2);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger);

      await adapter.release('worker-1', sampleItem);

      const zaddCalls = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls;
      expect(zaddCalls[0][0]).toBe('orchestrator:queue:dead-letter');
    });

    it('should allow custom maxRetries via config', async () => {
      // With maxRetries=5, attemptCount 2 -> 3 should NOT dead-letter
      const serialized = buildSerializedItem(sampleItem, 2);
      const redis = createMockRedis({
        hget: vi.fn().mockResolvedValue(JSON.stringify(serialized)),
      });
      const adapter = new RedisQueueAdapter(redis, logger, { maxRetries: 5 });

      await adapter.release('worker-1', sampleItem);

      const zaddCalls = (redis.zadd as ReturnType<typeof vi.fn>).mock.calls;
      expect(zaddCalls[0][0]).toBe('orchestrator:queue:pending');
    });
  });
});
