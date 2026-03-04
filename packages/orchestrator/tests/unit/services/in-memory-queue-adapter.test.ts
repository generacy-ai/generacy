import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryQueueAdapter } from '../../../src/services/in-memory-queue-adapter.js';
import type { QueueItem } from '../../../src/types/index.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: 'test-org',
    repo: 'test-repo',
    issueNumber: 42,
    workflowName: 'speckit-feature',
    command: 'process',
    priority: 1000,
    enqueuedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('InMemoryQueueAdapter', () => {
  let logger: ReturnType<typeof createMockLogger>;
  let adapter: InMemoryQueueAdapter;

  beforeEach(() => {
    logger = createMockLogger();
    adapter = new InMemoryQueueAdapter(logger);
  });

  describe('enqueue', () => {
    it('should add item to pending queue', async () => {
      await adapter.enqueue(makeItem());

      expect(await adapter.getQueueDepth()).toBe(1);
    });

    it('should log info on successful enqueue', async () => {
      await adapter.enqueue(makeItem());

      expect(logger.info).toHaveBeenCalledWith(
        { owner: 'test-org', repo: 'test-repo', issue: 42, priority: 1000 },
        'Item enqueued to in-memory queue'
      );
    });

    it('should reject duplicate item key already in pending', async () => {
      await adapter.enqueue(makeItem());
      await adapter.enqueue(makeItem());

      expect(await adapter.getQueueDepth()).toBe(1);
      expect(logger.debug).toHaveBeenCalledWith(
        { itemKey: 'test-org/test-repo#42' },
        'Duplicate item key in pending queue, skipping enqueue'
      );
    });

    it('should reject duplicate item key already claimed by a worker', async () => {
      await adapter.enqueue(makeItem());
      await adapter.claim('worker-1');

      // Item is now claimed — enqueue same key again
      await adapter.enqueue(makeItem());

      expect(await adapter.getQueueDepth()).toBe(0);
      expect(logger.debug).toHaveBeenCalledWith(
        { itemKey: 'test-org/test-repo#42' },
        'Duplicate item key in claimed set, skipping enqueue'
      );
    });

    it('should allow different items to be enqueued', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));
      await adapter.enqueue(makeItem({ issueNumber: 3 }));

      expect(await adapter.getQueueDepth()).toBe(3);
    });

    it('should preserve metadata on enqueued items', async () => {
      await adapter.enqueue(makeItem({ metadata: { description: 'Test issue' } }));

      const items = await adapter.getQueueItems(0, 10);
      expect(items[0].item.metadata).toEqual({ description: 'Test issue' });
    });
  });

  describe('priority ordering', () => {
    it('should claim higher priority items first (lower score = higher priority)', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1, priority: 3000 }));
      await adapter.enqueue(makeItem({ issueNumber: 2, priority: 1000 }));
      await adapter.enqueue(makeItem({ issueNumber: 3, priority: 2000 }));

      const first = await adapter.claim('worker-1');
      const second = await adapter.claim('worker-2');
      const third = await adapter.claim('worker-3');

      expect(first!.issueNumber).toBe(2);  // priority 1000
      expect(second!.issueNumber).toBe(3); // priority 2000
      expect(third!.issueNumber).toBe(1);  // priority 3000
    });

    it('should use FIFO ordering within the same priority', async () => {
      await adapter.enqueue(
        makeItem({ issueNumber: 1, priority: 1000, enqueuedAt: '2024-01-01T00:00:01Z' })
      );
      await adapter.enqueue(
        makeItem({ issueNumber: 2, priority: 1000, enqueuedAt: '2024-01-01T00:00:02Z' })
      );
      await adapter.enqueue(
        makeItem({ issueNumber: 3, priority: 1000, enqueuedAt: '2024-01-01T00:00:03Z' })
      );

      const first = await adapter.claim('worker-1');
      const second = await adapter.claim('worker-2');
      const third = await adapter.claim('worker-3');

      expect(first!.issueNumber).toBe(1);
      expect(second!.issueNumber).toBe(2);
      expect(third!.issueNumber).toBe(3);
    });

    it('should insert items in sorted order regardless of enqueue order', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 3, priority: 3000 }));
      await adapter.enqueue(makeItem({ issueNumber: 1, priority: 1000 }));
      await adapter.enqueue(makeItem({ issueNumber: 2, priority: 2000 }));

      const items = await adapter.getQueueItems(0, 10);
      expect(items.map((i) => i.item.issueNumber)).toEqual([1, 2, 3]);
    });
  });

  describe('claim', () => {
    it('should return null when queue is empty', async () => {
      const result = await adapter.claim('worker-1');

      expect(result).toBeNull();
    });

    it('should remove item from pending and return it', async () => {
      await adapter.enqueue(makeItem());

      const claimed = await adapter.claim('worker-1');

      expect(claimed).toEqual({
        owner: 'test-org',
        repo: 'test-repo',
        issueNumber: 42,
        workflowName: 'speckit-feature',
        command: 'process',
        priority: 1000,
        enqueuedAt: '2024-01-01T00:00:00Z',
        metadata: undefined,
      });
      expect(await adapter.getQueueDepth()).toBe(0);
    });

    it('should track claimed item under worker', async () => {
      await adapter.enqueue(makeItem());
      await adapter.claim('worker-1');

      expect(await adapter.getActiveWorkerCount()).toBe(1);
    });

    it('should log info with workerId and itemKey on successful claim', async () => {
      await adapter.enqueue(makeItem());
      await adapter.claim('worker-1');

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42', attempt: 0 },
        'Item claimed from in-memory queue'
      );
    });

    it('should not include internal fields (attemptCount, itemKey) in returned item', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');

      expect(claimed).not.toHaveProperty('attemptCount');
      expect(claimed).not.toHaveProperty('itemKey');
    });

    it('should allow multiple workers to claim different items', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));

      const item1 = await adapter.claim('worker-1');
      const item2 = await adapter.claim('worker-2');

      expect(item1!.issueNumber).toBe(1);
      expect(item2!.issueNumber).toBe(2);
      expect(await adapter.getActiveWorkerCount()).toBe(2);
    });
  });

  describe('release', () => {
    it('should re-enqueue item to pending queue', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');

      await adapter.release('worker-1', claimed!);

      expect(await adapter.getQueueDepth()).toBe(1);
      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should increment attempt count on release', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.release('worker-1', claimed!);

      // Claim again and check log for incremented attempt count
      await adapter.claim('worker-2');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'worker-2', attempt: 1 }),
        'Item claimed from in-memory queue'
      );
    });

    it('should log info when re-queuing', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.release('worker-1', claimed!);

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42', attemptCount: 1 },
        'Item released back to pending queue'
      );
    });

    it('should dead-letter item after maxRetries exceeded (default 3)', async () => {
      const item = makeItem();

      // Simulate 3 claim/release cycles
      for (let i = 0; i < 3; i++) {
        await adapter.enqueue(item);
        const claimed = await adapter.claim(`worker-${i}`);
        await adapter.release(`worker-${i}`, claimed!);
      }

      // After 3 releases, the item should be dead-lettered, not re-queued
      expect(await adapter.getQueueDepth()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        {
          workerId: 'worker-2',
          itemKey: 'test-org/test-repo#42',
          attemptCount: 3,
          maxRetries: 3,
        },
        'Item dead-lettered after max retries'
      );
    });

    it('should dead-letter after custom maxRetries', async () => {
      const customAdapter = new InMemoryQueueAdapter(logger, { maxRetries: 1 });
      const item = makeItem();

      await customAdapter.enqueue(item);
      const claimed = await customAdapter.claim('worker-1');
      await customAdapter.release('worker-1', claimed!);

      // With maxRetries=1, first release should dead-letter
      expect(await customAdapter.getQueueDepth()).toBe(0);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ attemptCount: 1, maxRetries: 1 }),
        'Item dead-lettered after max retries'
      );
    });

    it('should clean up empty worker entries from claimed map', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.release('worker-1', claimed!);

      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should handle release of item not in claimed set gracefully', async () => {
      // Release an item that was never claimed — should not throw
      await adapter.release('unknown-worker', makeItem());

      // Item gets re-queued with attemptCount 0
      expect(await adapter.getQueueDepth()).toBe(1);
    });
  });

  describe('complete', () => {
    it('should remove item from claimed set', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');

      await adapter.complete('worker-1', claimed!);

      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should not re-enqueue completed item', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.complete('worker-1', claimed!);

      expect(await adapter.getQueueDepth()).toBe(0);
    });

    it('should log info on completion', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.complete('worker-1', claimed!);

      expect(logger.info).toHaveBeenCalledWith(
        { workerId: 'worker-1', itemKey: 'test-org/test-repo#42' },
        'Item completed and removed from claimed set'
      );
    });

    it('should clean up attempt tracking for completed items', async () => {
      const item = makeItem();

      // Claim, release (incrementing attempt count), then re-enqueue and complete
      await adapter.enqueue(item);
      const claimed1 = await adapter.claim('worker-1');
      await adapter.release('worker-1', claimed1!);

      // Re-enqueue the released item (it was already re-queued by release)
      const claimed2 = await adapter.claim('worker-2');
      await adapter.complete('worker-2', claimed2!);

      // Now enqueue same item again — should start fresh with attemptCount 0
      await adapter.enqueue(item);
      await adapter.claim('worker-3');

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ workerId: 'worker-3', attempt: 0 }),
        'Item claimed from in-memory queue'
      );
    });

    it('should clean up empty worker entries from claimed map', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.complete('worker-1', claimed!);

      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should handle complete of item not in claimed set gracefully', async () => {
      // Complete an item that was never claimed — should not throw
      await adapter.complete('unknown-worker', makeItem());
    });
  });

  describe('getQueueDepth', () => {
    it('should return 0 for empty queue', async () => {
      expect(await adapter.getQueueDepth()).toBe(0);
    });

    it('should return correct count after enqueuing', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));
      await adapter.enqueue(makeItem({ issueNumber: 3 }));

      expect(await adapter.getQueueDepth()).toBe(3);
    });

    it('should decrease after claiming', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));
      await adapter.claim('worker-1');

      expect(await adapter.getQueueDepth()).toBe(1);
    });
  });

  describe('getQueueItems', () => {
    it('should return empty array for empty queue', async () => {
      const items = await adapter.getQueueItems(0, 10);

      expect(items).toEqual([]);
    });

    it('should return items with scores in priority order', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1, priority: 2000 }));
      await adapter.enqueue(makeItem({ issueNumber: 2, priority: 1000 }));

      const items = await adapter.getQueueItems(0, 10);

      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({
        item: expect.objectContaining({ issueNumber: 2, priority: 1000 }),
        score: 1000,
      });
      expect(items[1]).toEqual({
        item: expect.objectContaining({ issueNumber: 1, priority: 2000 }),
        score: 2000,
      });
    });

    it('should strip internal fields from returned items', async () => {
      await adapter.enqueue(makeItem());

      const items = await adapter.getQueueItems(0, 10);

      expect(items[0].item).not.toHaveProperty('attemptCount');
      expect(items[0].item).not.toHaveProperty('itemKey');
    });

    it('should respect offset and limit', async () => {
      for (let i = 1; i <= 5; i++) {
        await adapter.enqueue(makeItem({ issueNumber: i, priority: i * 1000 }));
      }

      const items = await adapter.getQueueItems(1, 2);

      expect(items).toHaveLength(2);
      expect(items[0].item.issueNumber).toBe(2);
      expect(items[1].item.issueNumber).toBe(3);
    });

    it('should return remaining items when offset + limit exceeds queue size', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));

      const items = await adapter.getQueueItems(1, 100);

      expect(items).toHaveLength(1);
      expect(items[0].item.issueNumber).toBe(2);
    });
  });

  describe('getActiveWorkerCount', () => {
    it('should return 0 when no items are claimed', async () => {
      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should count total claimed items across all workers', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));
      await adapter.enqueue(makeItem({ issueNumber: 3 }));

      await adapter.claim('worker-1'); // claims issue 1
      await adapter.claim('worker-1'); // claims issue 2
      await adapter.claim('worker-2'); // claims issue 3

      expect(await adapter.getActiveWorkerCount()).toBe(3);
    });

    it('should decrease when items are completed', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      await adapter.enqueue(makeItem({ issueNumber: 2 }));

      const item1 = await adapter.claim('worker-1');
      await adapter.claim('worker-2');

      await adapter.complete('worker-1', item1!);

      expect(await adapter.getActiveWorkerCount()).toBe(1);
    });

    it('should decrease when items are released', async () => {
      await adapter.enqueue(makeItem({ issueNumber: 1 }));
      const item = await adapter.claim('worker-1');
      await adapter.release('worker-1', item!);

      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });
  });

  describe('constructor defaults', () => {
    it('should default maxRetries to 3', async () => {
      const item = makeItem();

      // 2 releases should re-queue, 3rd should dead-letter
      for (let i = 0; i < 2; i++) {
        await adapter.enqueue(item);
        const claimed = await adapter.claim(`worker-${i}`);
        await adapter.release(`worker-${i}`, claimed!);
      }

      // After 2 releases, item should still be re-queued
      expect(await adapter.getQueueDepth()).toBe(1);

      // 3rd release should dead-letter
      const claimed = await adapter.claim('worker-final');
      await adapter.release('worker-final', claimed!);

      expect(await adapter.getQueueDepth()).toBe(0);
    });

    it('should allow custom maxRetries via config', async () => {
      const customAdapter = new InMemoryQueueAdapter(logger, { maxRetries: 5 });
      const item = makeItem();

      // 4 releases should still re-queue
      for (let i = 0; i < 4; i++) {
        await customAdapter.enqueue(item);
        const claimed = await customAdapter.claim(`worker-${i}`);
        await customAdapter.release(`worker-${i}`, claimed!);
      }

      expect(await customAdapter.getQueueDepth()).toBe(1);

      // 5th release should dead-letter
      const claimed = await customAdapter.claim('worker-final');
      await customAdapter.release('worker-final', claimed!);

      expect(await customAdapter.getQueueDepth()).toBe(0);
    });
  });

  describe('end-to-end workflow', () => {
    it('should handle full lifecycle: enqueue → claim → complete', async () => {
      await adapter.enqueue(makeItem());

      expect(await adapter.getQueueDepth()).toBe(1);
      expect(await adapter.getActiveWorkerCount()).toBe(0);

      const claimed = await adapter.claim('worker-1');

      expect(await adapter.getQueueDepth()).toBe(0);
      expect(await adapter.getActiveWorkerCount()).toBe(1);

      await adapter.complete('worker-1', claimed!);

      expect(await adapter.getQueueDepth()).toBe(0);
      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should handle full lifecycle: enqueue → claim → release → claim → complete', async () => {
      await adapter.enqueue(makeItem());

      const claimed1 = await adapter.claim('worker-1');
      await adapter.release('worker-1', claimed1!);

      // Item is back in pending
      expect(await adapter.getQueueDepth()).toBe(1);

      const claimed2 = await adapter.claim('worker-2');
      await adapter.complete('worker-2', claimed2!);

      expect(await adapter.getQueueDepth()).toBe(0);
      expect(await adapter.getActiveWorkerCount()).toBe(0);
    });

    it('should allow re-enqueue of same key after completion', async () => {
      await adapter.enqueue(makeItem());
      const claimed = await adapter.claim('worker-1');
      await adapter.complete('worker-1', claimed!);

      // Same item key should be accepted again after completion
      await adapter.enqueue(makeItem());
      expect(await adapter.getQueueDepth()).toBe(1);
    });
  });
});
