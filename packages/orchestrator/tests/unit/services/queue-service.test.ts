import { describe, it, expect, beforeEach } from 'vitest';
import {
  QueueService,
  InMemoryQueueStore,
} from '../../../src/services/queue-service.js';
import type { DecisionQueueItem } from '../../../src/types/index.js';

describe('QueueService', () => {
  let store: InMemoryQueueStore;
  let service: QueueService;

  const createDecision = (
    overrides: Partial<DecisionQueueItem> = {}
  ): DecisionQueueItem => ({
    id: crypto.randomUUID(),
    workflowId: crypto.randomUUID(),
    stepId: 'step-1',
    type: 'approval',
    prompt: 'Approve this change?',
    context: {},
    priority: 'when_available',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  beforeEach(() => {
    store = new InMemoryQueueStore();
    service = new QueueService(store);
  });

  describe('getQueue', () => {
    it('should return empty queue initially', async () => {
      const queue = await service.getQueue();
      expect(queue).toHaveLength(0);
    });

    it('should return all decisions', async () => {
      store.addDecision(createDecision({ id: '1' }));
      store.addDecision(createDecision({ id: '2' }));
      store.addDecision(createDecision({ id: '3' }));

      const queue = await service.getQueue();
      expect(queue).toHaveLength(3);
    });

    it('should filter by priority', async () => {
      store.addDecision(createDecision({ id: '1', priority: 'blocking_now' }));
      store.addDecision(createDecision({ id: '2', priority: 'when_available' }));
      store.addDecision(createDecision({ id: '3', priority: 'blocking_now' }));

      const queue = await service.getQueue({ priority: 'blocking_now' });
      expect(queue).toHaveLength(2);
      expect(queue.every((d) => d.priority === 'blocking_now')).toBe(true);
    });

    it('should filter by workflowId', async () => {
      const workflowId = crypto.randomUUID();
      store.addDecision(createDecision({ id: '1', workflowId }));
      store.addDecision(createDecision({ id: '2' }));
      store.addDecision(createDecision({ id: '3', workflowId }));

      const queue = await service.getQueue({ workflowId });
      expect(queue).toHaveLength(2);
      expect(queue.every((d) => d.workflowId === workflowId)).toBe(true);
    });

    it('should sort by priority', async () => {
      store.addDecision(createDecision({ id: '1', priority: 'when_available' }));
      store.addDecision(createDecision({ id: '2', priority: 'blocking_now' }));
      store.addDecision(createDecision({ id: '3', priority: 'blocking_soon' }));

      const queue = await service.getQueue();
      expect(queue[0]?.priority).toBe('blocking_now');
      expect(queue[1]?.priority).toBe('blocking_soon');
      expect(queue[2]?.priority).toBe('when_available');
    });
  });

  describe('getDecision', () => {
    it('should get decision by ID', async () => {
      const decision = createDecision({ id: 'test-id' });
      store.addDecision(decision);

      const result = await service.getDecision('test-id');
      expect(result.id).toBe('test-id');
    });

    it('should throw error for non-existent decision', async () => {
      await expect(service.getDecision('non-existent')).rejects.toThrow('not found');
    });
  });

  describe('respond', () => {
    it('should respond to a decision', async () => {
      const decision = createDecision({ id: 'test-id' });
      store.addDecision(decision);

      const response = await service.respond(
        'test-id',
        { response: true, comment: 'Approved' },
        'user:123'
      );

      expect(response.id).toBe('test-id');
      expect(response.response).toBe(true);
      expect(response.comment).toBe('Approved');
      expect(response.respondedBy).toBe('user:123');
      expect(response.respondedAt).toBeDefined();
    });

    it('should remove decision from queue after response', async () => {
      const decision = createDecision({ id: 'test-id' });
      store.addDecision(decision);

      await service.respond('test-id', { response: 'yes' }, 'user:123');

      const queue = await service.getQueue();
      expect(queue).toHaveLength(0);
    });

    it('should throw error for non-existent decision', async () => {
      await expect(
        service.respond('non-existent', { response: true }, 'user:123')
      ).rejects.toThrow('not found');
    });

    it('should throw error for already responded decision', async () => {
      const decision = createDecision({ id: 'test-id' });
      store.addDecision(decision);

      await service.respond('test-id', { response: true }, 'user:123');

      await expect(
        service.respond('test-id', { response: true }, 'user:456')
      ).rejects.toThrow('not found'); // Decision removed after first response
    });

    it('should throw error for expired decision', async () => {
      const pastDate = new Date();
      pastDate.setHours(pastDate.getHours() - 1);

      const decision = createDecision({
        id: 'test-id',
        expiresAt: pastDate.toISOString(),
      });
      store.addDecision(decision);

      await expect(
        service.respond('test-id', { response: true }, 'user:123')
      ).rejects.toThrow('expired');
    });
  });

  describe('getQueueStats', () => {
    it('should return stats by priority', async () => {
      store.addDecision(createDecision({ priority: 'blocking_now' }));
      store.addDecision(createDecision({ priority: 'blocking_now' }));
      store.addDecision(createDecision({ priority: 'blocking_soon' }));
      store.addDecision(createDecision({ priority: 'when_available' }));
      store.addDecision(createDecision({ priority: 'when_available' }));
      store.addDecision(createDecision({ priority: 'when_available' }));

      const stats = await service.getQueueStats();

      expect(stats.blocking_now).toBe(2);
      expect(stats.blocking_soon).toBe(1);
      expect(stats.when_available).toBe(3);
    });

    it('should return zero counts for empty queue', async () => {
      const stats = await service.getQueueStats();

      expect(stats.blocking_now).toBe(0);
      expect(stats.blocking_soon).toBe(0);
      expect(stats.when_available).toBe(0);
    });
  });
});

describe('InMemoryQueueStore', () => {
  let store: InMemoryQueueStore;

  beforeEach(() => {
    store = new InMemoryQueueStore();
  });

  it('should clear all decisions', async () => {
    store.addDecision({
      id: '1',
      workflowId: crypto.randomUUID(),
      stepId: 'step-1',
      type: 'approval',
      prompt: 'Test',
      context: {},
      priority: 'when_available',
      createdAt: new Date().toISOString(),
    });

    expect(store.size()).toBe(1);

    store.clear();

    expect(store.size()).toBe(0);
  });
});
