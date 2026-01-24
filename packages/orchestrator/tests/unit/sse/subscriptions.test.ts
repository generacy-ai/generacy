import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { FastifyRequest } from 'fastify';
import type { ServerResponse, IncomingMessage } from 'http';
import {
  SSESubscriptionManager,
  resetSSESubscriptionManager,
} from '../../../src/sse/subscriptions.js';
import { SSEStream } from '../../../src/sse/stream.js';
import type { SSEChannel } from '../../../src/types/sse.js';

// Mock ServerResponse
function createMockResponse(): ServerResponse {
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    writtenData: [] as string[],
    writableEnded: false,
    setHeader: vi.fn(),
    write: vi.fn((data: string) => {
      response.writtenData.push(data);
      return true;
    }),
    end: vi.fn(() => {
      response.writableEnded = true;
    }),
  });
  return response as unknown as ServerResponse;
}

// Mock IncomingMessage
function createMockRequest(): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage;
  (request as unknown as { headers: Record<string, string> }).headers = {};
  return request;
}

// Mock FastifyRequest
function createMockFastifyRequest(): FastifyRequest {
  const raw = createMockRequest();
  return {
    raw,
    headers: {},
  } as unknown as FastifyRequest;
}

// Create mock SSEStream
function createMockStream(
  userId: string = 'user_123',
  channels: SSEChannel[] = ['workflows', 'queue', 'agents'],
  filters: { workflowId?: string } = {}
): SSEStream {
  const response = createMockResponse();
  const request = createMockFastifyRequest();

  return new SSEStream(response, request, userId, { channels, filters });
}

describe('SSESubscriptionManager', () => {
  let manager: SSESubscriptionManager;

  beforeEach(() => {
    resetSSESubscriptionManager();
    manager = new SSESubscriptionManager();
  });

  afterEach(() => {
    manager.clear();
  });

  describe('addConnection', () => {
    it('should add connection successfully', () => {
      const stream = createMockStream();

      const result = manager.addConnection(stream);

      expect(result).toBe(true);
      expect(manager.getTotalConnections()).toBe(1);
    });

    it('should track connection by ID', () => {
      const stream = createMockStream();
      manager.addConnection(stream);

      const retrieved = manager.getConnection(stream.id);

      expect(retrieved).toBe(stream);
    });

    it('should enforce per-user connection limit', () => {
      const stream1 = createMockStream('user_123');
      const stream2 = createMockStream('user_123');
      const stream3 = createMockStream('user_123');
      const stream4 = createMockStream('user_123');

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);
      const result = manager.addConnection(stream4);

      expect(result).toBe(false);
      expect(manager.getTotalConnections()).toBe(3);
    });

    it('should allow connections from different users', () => {
      const stream1 = createMockStream('user_1');
      const stream2 = createMockStream('user_2');
      const stream3 = createMockStream('user_3');
      const stream4 = createMockStream('user_4');

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);
      const result = manager.addConnection(stream4);

      expect(result).toBe(true);
      expect(manager.getTotalConnections()).toBe(4);
    });
  });

  describe('removeConnection', () => {
    it('should remove connection', () => {
      const stream = createMockStream();
      manager.addConnection(stream);

      manager.removeConnection(stream.id);

      expect(manager.getConnection(stream.id)).toBeUndefined();
      expect(manager.getTotalConnections()).toBe(0);
    });

    it('should remove from channel subscribers', () => {
      const stream = createMockStream('user_123', ['workflows']);
      manager.addConnection(stream);

      manager.removeConnection(stream.id);

      expect(manager.getChannelSubscribers('workflows')).toHaveLength(0);
    });

    it('should close the stream', () => {
      const stream = createMockStream();
      manager.addConnection(stream);

      manager.removeConnection(stream.id);

      expect(stream.isClosed).toBe(true);
    });
  });

  describe('getChannelSubscribers', () => {
    it('should return subscribers for a channel', () => {
      const stream1 = createMockStream('user_1', ['workflows']);
      const stream2 = createMockStream('user_2', ['workflows', 'queue']);
      const stream3 = createMockStream('user_3', ['queue']);

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);

      const workflowSubs = manager.getChannelSubscribers('workflows');
      const queueSubs = manager.getChannelSubscribers('queue');

      expect(workflowSubs).toHaveLength(2);
      expect(queueSubs).toHaveLength(2);
    });

    it('should exclude closed streams', () => {
      const stream1 = createMockStream('user_1', ['workflows']);
      const stream2 = createMockStream('user_2', ['workflows']);

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      stream1.close();

      const subscribers = manager.getChannelSubscribers('workflows');

      expect(subscribers).toHaveLength(1);
      expect(subscribers[0].id).toBe(stream2.id);
    });
  });

  describe('broadcast', () => {
    it('should broadcast to all channel subscribers', () => {
      const stream1 = createMockStream('user_1', ['workflows']);
      const stream2 = createMockStream('user_2', ['workflows']);
      const stream3 = createMockStream('user_3', ['queue']);

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);

      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: { workflowId: 'wf_123' },
        timestamp: '2024-01-24T10:00:00Z',
      };

      const sentCount = manager.broadcast('workflows', event);

      expect(sentCount).toBe(2);
    });

    it('should return count of successful sends', () => {
      const stream1 = createMockStream('user_1', ['workflows']);
      const stream2 = createMockStream('user_2', ['workflows']);

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      stream1.close(); // Close one stream

      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: {},
        timestamp: '2024-01-24T10:00:00Z',
      };

      const sentCount = manager.broadcast('workflows', event);

      expect(sentCount).toBe(1);
    });
  });

  describe('broadcastFiltered', () => {
    it('should apply filter matching', () => {
      const stream1 = createMockStream('user_1', ['workflows'], {
        workflowId: 'wf_123',
      });
      const stream2 = createMockStream('user_2', ['workflows'], {
        workflowId: 'wf_456',
      });

      manager.addConnection(stream1);
      manager.addConnection(stream2);

      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: { workflowId: 'wf_123' },
        timestamp: '2024-01-24T10:00:00Z',
      };

      const sentCount = manager.broadcastFiltered('workflows', event, (filters) => {
        return !filters.workflowId || filters.workflowId === 'wf_123';
      });

      expect(sentCount).toBe(1);
    });
  });

  describe('broadcastWorkflowEvent', () => {
    it('should broadcast to matching workflow subscribers', () => {
      const stream1 = createMockStream('user_1', ['workflows'], {
        workflowId: 'wf_123',
      });
      const stream2 = createMockStream('user_2', ['workflows'], {
        workflowId: 'wf_456',
      });
      const stream3 = createMockStream('user_3', ['workflows']); // No filter

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);

      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: { workflowId: 'wf_123' },
        timestamp: '2024-01-24T10:00:00Z',
      };

      const sentCount = manager.broadcastWorkflowEvent(event);

      // stream1 (matches wf_123) and stream3 (no filter) should receive
      expect(sentCount).toBe(2);
    });
  });

  describe('send', () => {
    it('should send to specific connection', () => {
      const stream = createMockStream();
      manager.addConnection(stream);
      stream.start();

      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: {},
        timestamp: '2024-01-24T10:00:00Z',
      };

      const result = manager.send(stream.id, event);

      expect(result).toBe(true);
    });

    it('should return false for unknown connection', () => {
      const event = {
        event: 'workflow:started' as const,
        id: 'test_id_1',
        data: {},
        timestamp: '2024-01-24T10:00:00Z',
      };

      const result = manager.send('unknown_id', event);

      expect(result).toBe(false);
    });
  });

  describe('getMissedEvents', () => {
    it('should return events after last event ID', () => {
      const stream = createMockStream('user_1', ['workflows']);
      manager.addConnection(stream);

      // Broadcast some events
      const now = Date.now();
      manager.broadcast('workflows', {
        event: 'workflow:started',
        id: `${now - 1000}_conn_abc_1`,
        data: { workflowId: 'wf_1' },
        timestamp: '2024-01-24T10:00:00Z',
      });
      manager.broadcast('workflows', {
        event: 'workflow:completed',
        id: `${now}_conn_abc_2`,
        data: { workflowId: 'wf_2' },
        timestamp: '2024-01-24T10:00:01Z',
      });

      const missed = manager.getMissedEvents(`${now - 500}_conn_abc_0`, ['workflows']);

      expect(missed).toHaveLength(1);
      expect((missed[0].data as { workflowId: string }).workflowId).toBe('wf_2');
    });

    it('should filter by channel', () => {
      const stream = createMockStream('user_1', ['workflows', 'queue']);
      manager.addConnection(stream);

      const now = Date.now();
      manager.broadcast('workflows', {
        event: 'workflow:started',
        id: `${now}_conn_abc_1`,
        data: {},
        timestamp: '2024-01-24T10:00:00Z',
      });
      manager.broadcast('queue', {
        event: 'queue:updated',
        id: `${now + 1}_conn_abc_2`,
        data: {},
        timestamp: '2024-01-24T10:00:01Z',
      });

      const missed = manager.getMissedEvents(`${now - 1}_conn_abc_0`, ['workflows']);

      expect(missed).toHaveLength(1);
    });
  });

  describe('getUserConnections', () => {
    it('should return all connections for a user', () => {
      const stream1 = createMockStream('user_123');
      const stream2 = createMockStream('user_123');
      const stream3 = createMockStream('other_user');

      manager.addConnection(stream1);
      manager.addConnection(stream2);
      manager.addConnection(stream3);

      const userConnections = manager.getUserConnections('user_123');

      expect(userConnections).toHaveLength(2);
    });
  });

  describe('statistics', () => {
    it('should return correct total connections', () => {
      manager.addConnection(createMockStream('user_1'));
      manager.addConnection(createMockStream('user_2'));
      manager.addConnection(createMockStream('user_3'));

      expect(manager.getTotalConnections()).toBe(3);
    });

    it('should return correct channel counts', () => {
      manager.addConnection(createMockStream('user_1', ['workflows']));
      manager.addConnection(createMockStream('user_2', ['workflows', 'queue']));
      manager.addConnection(createMockStream('user_3', ['queue', 'agents']));

      const counts = manager.getChannelCounts();

      expect(counts.workflows).toBe(2);
      expect(counts.queue).toBe(2);
      expect(counts.agents).toBe(1);
    });

    it('should return correct user counts', () => {
      manager.addConnection(createMockStream('user_1'));
      manager.addConnection(createMockStream('user_1'));
      manager.addConnection(createMockStream('user_2'));

      const counts = manager.getUserCounts();

      expect(counts.get('user_1')).toBe(2);
      expect(counts.get('user_2')).toBe(1);
    });
  });

  describe('closeAll', () => {
    it('should close all connections', () => {
      const stream1 = createMockStream('user_1');
      const stream2 = createMockStream('user_2');

      manager.addConnection(stream1);
      manager.addConnection(stream2);

      manager.closeAll();

      expect(stream1.isClosed).toBe(true);
      expect(stream2.isClosed).toBe(true);
      expect(manager.getTotalConnections()).toBe(0);
    });
  });
});
