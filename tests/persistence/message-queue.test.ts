import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageQueue } from '../../src/persistence/message-queue.js';
import type { MessageEnvelope } from '../../src/types/messages.js';

// Mock RedisStore
const createMockStore = () => {
  const queues = new Map<string, Array<{ streamId: string; message: MessageEnvelope }>>();
  let streamIdCounter = 0;

  return {
    enqueueMessage: vi.fn(async (type: 'agency' | 'humancy', recipientId: string, message: MessageEnvelope) => {
      const key = `${type}:${recipientId}`;
      if (!queues.has(key)) {
        queues.set(key, []);
      }
      const streamId = `${++streamIdCounter}-0`;
      queues.get(key)!.push({ streamId, message });
      return streamId;
    }),

    dequeueMessages: vi.fn(async (type: 'agency' | 'humancy', recipientId: string, count: number = 100) => {
      const key = `${type}:${recipientId}`;
      const queue = queues.get(key) ?? [];
      return queue.slice(0, count);
    }),

    acknowledgeMessages: vi.fn(async (type: 'agency' | 'humancy', recipientId: string, streamIds: string[]) => {
      const key = `${type}:${recipientId}`;
      const queue = queues.get(key);
      if (!queue) return 0;

      const before = queue.length;
      const remaining = queue.filter(e => !streamIds.includes(e.streamId));
      queues.set(key, remaining);
      return before - remaining.length;
    }),

    getQueueLength: vi.fn(async (type: 'agency' | 'humancy', recipientId: string) => {
      const key = `${type}:${recipientId}`;
      return queues.get(key)?.length ?? 0;
    }),

    // Helper for tests
    _getQueue: (type: 'agency' | 'humancy', recipientId: string) => {
      const key = `${type}:${recipientId}`;
      return queues.get(key) ?? [];
    },
  };
};

describe('MessageQueue', () => {
  let queue: MessageQueue;
  let mockStore: ReturnType<typeof createMockStore>;

  const createMessage = (id: string, ttl?: number): MessageEnvelope => ({
    id,
    type: 'mode_command',
    source: { type: 'router', id: 'router-1' },
    destination: { type: 'agency', id: 'agency-1' },
    payload: { command: 'test' },
    meta: {
      timestamp: Date.now(),
      ttl,
      attempts: 0,
    },
  });

  beforeEach(() => {
    mockStore = createMockStore();
    queue = new MessageQueue(mockStore as any);
  });

  describe('enqueue', () => {
    it('enqueues a message', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      expect(mockStore.enqueueMessage).toHaveBeenCalledWith(
        'agency',
        'agency-1',
        expect.objectContaining({
          id: 'msg-1',
          meta: expect.objectContaining({ attempts: 1 }),
        })
      );
    });

    it('increments attempt count', async () => {
      const message = createMessage('msg-1');
      message.meta.attempts = 2;

      await queue.enqueue('agency', 'agency-1', message);

      expect(mockStore.enqueueMessage).toHaveBeenCalledWith(
        'agency',
        'agency-1',
        expect.objectContaining({
          meta: expect.objectContaining({ attempts: 3 }),
        })
      );
    });

    it('emits message:enqueued event', async () => {
      const message = createMessage('msg-1');
      const enqueuedHandler = vi.fn();
      queue.on('message:enqueued', enqueuedHandler);

      await queue.enqueue('agency', 'agency-1', message);

      expect(enqueuedHandler).toHaveBeenCalledWith(
        'agency',
        'agency-1',
        expect.objectContaining({ id: 'msg-1' })
      );
    });

    it('does not enqueue expired messages', async () => {
      const message = createMessage('msg-1', 1000);
      message.meta.timestamp = Date.now() - 2000; // 2 seconds ago, 1 second TTL

      const expiredHandler = vi.fn();
      queue.on('message:expired', expiredHandler);

      await queue.enqueue('agency', 'agency-1', message);

      expect(mockStore.enqueueMessage).not.toHaveBeenCalled();
      expect(expiredHandler).toHaveBeenCalled();
    });
  });

  describe('deliverQueued', () => {
    it('delivers queued messages', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      const deliverFn = vi.fn().mockResolvedValue(undefined);
      const result = await queue.deliverQueued('agency', 'agency-1', deliverFn);

      expect(deliverFn).toHaveBeenCalled();
      expect(result.delivered).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.expired).toBe(0);
    });

    it('handles delivery failures', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      const deliverFn = vi.fn().mockRejectedValue(new Error('Delivery failed'));
      const failedHandler = vi.fn();
      queue.on('message:failed', failedHandler);

      const result = await queue.deliverQueued('agency', 'agency-1', deliverFn);

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(1);
      expect(failedHandler).toHaveBeenCalled();
    });

    it('acknowledges successfully delivered messages', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      const deliverFn = vi.fn().mockResolvedValue(undefined);
      await queue.deliverQueued('agency', 'agency-1', deliverFn);

      expect(mockStore.acknowledgeMessages).toHaveBeenCalled();
    });

    it('does not acknowledge failed messages', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      const deliverFn = vi.fn().mockRejectedValue(new Error('Delivery failed'));
      await queue.deliverQueued('agency', 'agency-1', deliverFn);

      // acknowledgeMessages should not be called when all messages fail
      // (implementation only calls it when toAcknowledge.length > 0)
      expect(mockStore.acknowledgeMessages).not.toHaveBeenCalled();
    });

    it('emits message:delivered event', async () => {
      const message = createMessage('msg-1');
      await queue.enqueue('agency', 'agency-1', message);

      const deliveredHandler = vi.fn();
      queue.on('message:delivered', deliveredHandler);

      const deliverFn = vi.fn().mockResolvedValue(undefined);
      await queue.deliverQueued('agency', 'agency-1', deliverFn);

      expect(deliveredHandler).toHaveBeenCalledWith(
        'agency',
        'agency-1',
        expect.objectContaining({ id: 'msg-1' })
      );
    });

    it('returns empty results when no messages queued', async () => {
      const deliverFn = vi.fn();
      const result = await queue.deliverQueued('agency', 'agency-1', deliverFn);

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.expired).toBe(0);
      expect(deliverFn).not.toHaveBeenCalled();
    });
  });

  describe('getQueueLength', () => {
    it('returns queue length', async () => {
      await queue.enqueue('agency', 'agency-1', createMessage('msg-1'));
      await queue.enqueue('agency', 'agency-1', createMessage('msg-2'));

      const length = await queue.getQueueLength('agency', 'agency-1');

      expect(length).toBe(2);
    });

    it('returns 0 for empty queue', async () => {
      const length = await queue.getQueueLength('agency', 'agency-1');

      expect(length).toBe(0);
    });
  });

  describe('peek', () => {
    it('returns messages without removing them', async () => {
      await queue.enqueue('agency', 'agency-1', createMessage('msg-1'));
      await queue.enqueue('agency', 'agency-1', createMessage('msg-2'));

      const messages = await queue.peek('agency', 'agency-1');

      expect(messages).toHaveLength(2);
      expect(messages[0]?.id).toBe('msg-1');
      expect(messages[1]?.id).toBe('msg-2');

      // Verify messages are still in queue
      const length = await queue.getQueueLength('agency', 'agency-1');
      expect(length).toBe(2);
    });

    it('respects count limit', async () => {
      await queue.enqueue('agency', 'agency-1', createMessage('msg-1'));
      await queue.enqueue('agency', 'agency-1', createMessage('msg-2'));
      await queue.enqueue('agency', 'agency-1', createMessage('msg-3'));

      const messages = await queue.peek('agency', 'agency-1', 2);

      expect(messages).toHaveLength(2);
    });
  });

  describe('event listeners', () => {
    it('removes listeners with off()', async () => {
      const message = createMessage('msg-1');
      const enqueuedHandler = vi.fn();

      queue.on('message:enqueued', enqueuedHandler);
      queue.off('message:enqueued', enqueuedHandler);

      await queue.enqueue('agency', 'agency-1', message);

      expect(enqueuedHandler).not.toHaveBeenCalled();
    });
  });
});
