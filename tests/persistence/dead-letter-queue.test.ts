import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeadLetterQueue, type DeadLetterEntry } from '../../src/persistence/dead-letter-queue.js';
import type { MessageEnvelope } from '../../src/types/messages.js';
import { REDIS_KEYS } from '../../src/persistence/redis-store.js';

// Mock RedisStore
const createMockStore = () => {
  const data = new Map<string, string>();
  const stream: Array<[string, string[]]> = [];
  let streamIdCounter = 0;

  return {
    set: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),

    get: vi.fn(async (key: string) => {
      return data.get(key) ?? null;
    }),

    del: vi.fn(async (key: string) => {
      data.delete(key);
    }),

    exists: vi.fn(async (key: string) => {
      return data.has(key);
    }),

    getClient: vi.fn(() => ({
      xadd: vi.fn(async (_stream: string, _id: string, ...fields: string[]) => {
        const streamId = `${++streamIdCounter}-0`;
        stream.push([streamId, fields]);
        return streamId;
      }),

      xrange: vi.fn(async () => {
        return stream;
      }),

      xdel: vi.fn(async (_stream: string, streamId: string) => {
        const idx = stream.findIndex(([id]) => id === streamId);
        if (idx !== -1) {
          stream.splice(idx, 1);
          return 1;
        }
        return 0;
      }),
    })),

    // Test helpers
    _data: data,
    _stream: stream,
  };
};

describe('DeadLetterQueue', () => {
  let dlq: DeadLetterQueue;
  let mockStore: ReturnType<typeof createMockStore>;

  const createMessage = (id: string, attempts = 0): MessageEnvelope => ({
    id,
    type: 'mode_command',
    source: { type: 'router', id: 'router-1' },
    destination: { type: 'agency', id: 'agency-1' },
    payload: { command: 'test' },
    meta: {
      timestamp: Date.now(),
      attempts,
    },
  });

  beforeEach(() => {
    mockStore = createMockStore();
    dlq = new DeadLetterQueue(mockStore as any, {
      maxAttempts: 3,
      initialDelay: 100,
      maxDelay: 1000,
      backoffFactor: 2,
    });
  });

  describe('add', () => {
    it('adds a message to the DLQ', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const entry = await dlq.get('msg-1');
      expect(entry).not.toBeNull();
      expect(entry?.message.id).toBe('msg-1');
      expect(entry?.error).toBe('Delivery failed');
      expect(entry?.attempts).toBe(1);
      expect(entry?.status).toBe('pending_retry');
    });

    it('marks as exceeded when max attempts reached', async () => {
      const message = createMessage('msg-1', 2); // Already 2 attempts
      const exceededHandler = vi.fn();
      dlq.on('entry:exceeded', exceededHandler);

      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const entry = await dlq.get('msg-1');
      expect(entry?.status).toBe('max_retries_exceeded');
      expect(exceededHandler).toHaveBeenCalled();
    });

    it('emits entry:added event', async () => {
      const message = createMessage('msg-1');
      const addedHandler = vi.fn();
      dlq.on('entry:added', addedHandler);

      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      expect(addedHandler).toHaveBeenCalled();
    });

    it('calculates next retry time with exponential backoff', async () => {
      const message = createMessage('msg-1', 1); // 1 previous attempt
      const now = Date.now();

      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const entry = await dlq.get('msg-1');
      // After 1 attempt, delay should be initialDelay * backoffFactor = 100 * 2 = 200 (plus jitter)
      expect(entry?.nextRetryAt).toBeGreaterThanOrEqual(now + 100);
      expect(entry?.nextRetryAt).toBeLessThanOrEqual(now + 400);
    });
  });

  describe('get', () => {
    it('returns null for non-existent entry', async () => {
      const entry = await dlq.get('non-existent');
      expect(entry).toBeNull();
    });

    it('returns entry by message ID', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const entry = await dlq.get('msg-1');
      expect(entry?.message.id).toBe('msg-1');
    });
  });

  describe('resolve', () => {
    it('marks entry as resolved', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const result = await dlq.resolve('msg-1');
      expect(result).toBe(true);

      const entry = await dlq.get('msg-1');
      expect(entry?.status).toBe('manually_resolved');
    });

    it('emits entry:resolved event', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const resolvedHandler = vi.fn();
      dlq.on('entry:resolved', resolvedHandler);

      await dlq.resolve('msg-1');

      expect(resolvedHandler).toHaveBeenCalled();
    });

    it('returns false for non-existent entry', async () => {
      const result = await dlq.resolve('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('markForRetry', () => {
    it('resets next retry time to now', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const before = await dlq.get('msg-1');
      expect(before?.nextRetryAt).toBeGreaterThan(Date.now());

      const result = await dlq.markForRetry('msg-1');
      expect(result).toBe(true);

      const after = await dlq.get('msg-1');
      expect(after?.nextRetryAt).toBeLessThanOrEqual(Date.now() + 10);
    });

    it('returns false for non-existent entry', async () => {
      const result = await dlq.markForRetry('non-existent');
      expect(result).toBe(false);
    });

    it('returns false for resolved entry', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');
      await dlq.resolve('msg-1');

      const result = await dlq.markForRetry('msg-1');
      expect(result).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes entry from DLQ', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('Delivery failed'), 'agency', 'agency-1');

      const result = await dlq.delete('msg-1');
      expect(result).toBe(true);

      const entry = await dlq.get('msg-1');
      expect(entry).toBeNull();
    });

    it('returns false for non-existent entry', async () => {
      const result = await dlq.delete('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('list', () => {
    it('returns all entries', async () => {
      await dlq.add(createMessage('msg-1'), new Error('err'), 'agency', 'agency-1');
      await dlq.add(createMessage('msg-2'), new Error('err'), 'agency', 'agency-2');

      const entries = await dlq.list();
      expect(entries).toHaveLength(2);
    });

    it('filters by status', async () => {
      await dlq.add(createMessage('msg-1', 0), new Error('err'), 'agency', 'agency-1');
      await dlq.add(createMessage('msg-2', 2), new Error('err'), 'agency', 'agency-2'); // Will exceed

      const pending = await dlq.list('pending_retry');
      const exceeded = await dlq.list('max_retries_exceeded');

      expect(pending).toHaveLength(1);
      expect(exceeded).toHaveLength(1);
    });
  });

  describe('getReadyForRetry', () => {
    it('returns entries with nextRetryAt in the past', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('err'), 'agency', 'agency-1');

      // Force nextRetryAt to be in the past
      const entry = await dlq.get('msg-1');
      if (entry) {
        entry.nextRetryAt = Date.now() - 1000;
        await mockStore.set(`${REDIS_KEYS.DLQ_ENTRY}${message.id}`, JSON.stringify(entry));
      }

      const ready = await dlq.getReadyForRetry();
      expect(ready).toHaveLength(1);
    });
  });

  describe('recordRetryAttempt', () => {
    it('marks as resolved on success', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('err'), 'agency', 'agency-1');

      const resolvedHandler = vi.fn();
      dlq.on('entry:resolved', resolvedHandler);

      await dlq.recordRetryAttempt('msg-1', true);

      expect(resolvedHandler).toHaveBeenCalled();
    });

    it('increments attempts on failure', async () => {
      const message = createMessage('msg-1');
      await dlq.add(message, new Error('err'), 'agency', 'agency-1');

      await dlq.recordRetryAttempt('msg-1', false, new Error('Still failing'));

      const entry = await dlq.get('msg-1');
      expect(entry?.attempts).toBe(2);
      expect(entry?.error).toBe('Still failing');
    });

    it('marks exceeded when max attempts reached', async () => {
      const message = createMessage('msg-1', 1); // Already 1 attempt
      await dlq.add(message, new Error('err'), 'agency', 'agency-1'); // Now 2

      const exceededHandler = vi.fn();
      dlq.on('entry:exceeded', exceededHandler);

      await dlq.recordRetryAttempt('msg-1', false, new Error('Still failing')); // Now 3

      expect(exceededHandler).toHaveBeenCalled();
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', async () => {
      await dlq.add(createMessage('msg-1', 0), new Error('err'), 'agency', 'agency-1'); // pending
      await dlq.add(createMessage('msg-2', 2), new Error('err'), 'agency', 'agency-2'); // exceeded
      await dlq.add(createMessage('msg-3', 0), new Error('err'), 'agency', 'agency-3'); // pending

      const stats = await dlq.getStats();

      // Note: resolve() removes entry from stream, so we don't test resolved count here
      // The resolved status is set in memory but entry is deleted from stream
      expect(stats.total).toBe(3);
      expect(stats.pendingRetry).toBe(2);
      expect(stats.exceeded).toBe(1);
      expect(stats.resolved).toBe(0);
    });

    it('excludes resolved entries from stats', async () => {
      await dlq.add(createMessage('msg-1', 0), new Error('err'), 'agency', 'agency-1');
      await dlq.resolve('msg-1');

      const stats = await dlq.getStats();
      // Resolved entries are removed from stream
      expect(stats.total).toBe(0);
    });
  });

  describe('event listeners', () => {
    it('removes listeners with off()', async () => {
      const message = createMessage('msg-1');
      const addedHandler = vi.fn();

      dlq.on('entry:added', addedHandler);
      dlq.off('entry:added', addedHandler);

      await dlq.add(message, new Error('err'), 'agency', 'agency-1');

      expect(addedHandler).not.toHaveBeenCalled();
    });
  });
});
