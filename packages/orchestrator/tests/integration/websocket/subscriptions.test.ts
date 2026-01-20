import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubscriptionManager,
  resetSubscriptionManager,
} from '../../../src/websocket/subscriptions.js';
import {
  createWorkflowEventMessage,
  createQueueUpdateMessage,
  createPongMessage,
} from '../../../src/websocket/messages.js';
import type WebSocket from 'ws';

// Mock WebSocket
function createMockWebSocket(readyState: number = 1): WebSocket {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
  } as unknown as WebSocket;
}

describe('SubscriptionManager', () => {
  let manager: SubscriptionManager;

  beforeEach(() => {
    resetSubscriptionManager();
    manager = new SubscriptionManager();
  });

  afterEach(() => {
    manager.clear();
  });

  describe('subscribe', () => {
    it('should subscribe client to channels', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows', 'queue']);

      const subscription = manager.getSubscription(ws);
      expect(subscription).toBeDefined();
      expect(subscription?.channels.has('workflows')).toBe(true);
      expect(subscription?.channels.has('queue')).toBe(true);
    });

    it('should add client to channel subscribers', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows']);

      const subscribers = manager.getChannelSubscribers('workflows');
      expect(subscribers.has(ws)).toBe(true);
    });

    it('should store subscription filters', () => {
      const ws = createMockWebSocket();
      const workflowId = 'test-workflow-id';

      manager.subscribe(ws, ['workflows'], { workflowId });

      const subscription = manager.getSubscription(ws);
      expect(subscription?.filters.workflowId).toBe(workflowId);
    });

    it('should update filters on re-subscribe', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows'], { workflowId: 'first' });
      manager.subscribe(ws, ['queue'], { workflowId: 'second' });

      const subscription = manager.getSubscription(ws);
      expect(subscription?.filters.workflowId).toBe('second');
      expect(subscription?.channels.has('workflows')).toBe(true);
      expect(subscription?.channels.has('queue')).toBe(true);
    });
  });

  describe('unsubscribe', () => {
    it('should unsubscribe client from channels', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows', 'queue']);
      manager.unsubscribe(ws, ['workflows']);

      const subscription = manager.getSubscription(ws);
      expect(subscription?.channels.has('workflows')).toBe(false);
      expect(subscription?.channels.has('queue')).toBe(true);
    });

    it('should remove subscription when no channels left', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows']);
      manager.unsubscribe(ws, ['workflows']);

      expect(manager.getSubscription(ws)).toBeUndefined();
    });

    it('should remove client from channel subscribers', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows']);
      manager.unsubscribe(ws, ['workflows']);

      const subscribers = manager.getChannelSubscribers('workflows');
      expect(subscribers.has(ws)).toBe(false);
    });
  });

  describe('removeClient', () => {
    it('should remove all subscriptions for client', () => {
      const ws = createMockWebSocket();

      manager.subscribe(ws, ['workflows', 'queue', 'agents']);
      manager.removeClient(ws);

      expect(manager.getSubscription(ws)).toBeUndefined();
      expect(manager.getChannelSubscribers('workflows').has(ws)).toBe(false);
      expect(manager.getChannelSubscribers('queue').has(ws)).toBe(false);
      expect(manager.getChannelSubscribers('agents').has(ws)).toBe(false);
    });
  });

  describe('broadcast', () => {
    it('should broadcast to all channel subscribers', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows']);
      manager.subscribe(ws2, ['workflows']);
      manager.subscribe(ws3, ['queue']); // Different channel

      const message = createPongMessage();
      manager.broadcast('workflows', message);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).toHaveBeenCalled();
      expect(ws3.send).not.toHaveBeenCalled();
    });

    it('should not broadcast to closed connections', () => {
      const openWs = createMockWebSocket(1); // OPEN
      const closedWs = createMockWebSocket(3); // CLOSED

      manager.subscribe(openWs, ['workflows']);
      manager.subscribe(closedWs, ['workflows']);

      const message = createPongMessage();
      manager.broadcast('workflows', message);

      expect(openWs.send).toHaveBeenCalled();
      expect(closedWs.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastFiltered', () => {
    it('should apply filter matching', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows'], { workflowId: 'workflow-1' });
      manager.subscribe(ws2, ['workflows'], { workflowId: 'workflow-2' });

      const message = createWorkflowEventMessage(
        'workflow:started',
        'workflow-1',
        {}
      );

      manager.broadcastFiltered('workflows', message, (filters) => {
        return !filters.workflowId || filters.workflowId === 'workflow-1';
      });

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastWorkflowEvent', () => {
    it('should broadcast to subscribers with matching workflow ID', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows'], { workflowId: 'workflow-1' });
      manager.subscribe(ws2, ['workflows'], { workflowId: 'workflow-2' });

      const message = createWorkflowEventMessage(
        'workflow:started',
        'workflow-1',
        {}
      );

      manager.broadcastWorkflowEvent(message);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it('should broadcast to subscribers without filters', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows']); // No filter
      manager.subscribe(ws2, ['workflows'], { workflowId: 'other-workflow' });

      const message = createWorkflowEventMessage(
        'workflow:started',
        'workflow-1',
        {}
      );

      manager.broadcastWorkflowEvent(message);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });
  });

  describe('send', () => {
    it('should send message to specific client', () => {
      const ws = createMockWebSocket();

      manager.send(ws, createPongMessage());

      expect(ws.send).toHaveBeenCalled();
    });

    it('should not send to closed connection', () => {
      const ws = createMockWebSocket(3); // CLOSED

      manager.send(ws, createPongMessage());

      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  describe('statistics', () => {
    it('should return total subscriber count', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows']);
      manager.subscribe(ws2, ['queue']);
      manager.subscribe(ws3, ['workflows', 'queue']);

      expect(manager.getTotalSubscribers()).toBe(3);
    });

    it('should return channel counts', () => {
      const ws1 = createMockWebSocket();
      const ws2 = createMockWebSocket();
      const ws3 = createMockWebSocket();

      manager.subscribe(ws1, ['workflows']);
      manager.subscribe(ws2, ['workflows', 'queue']);
      manager.subscribe(ws3, ['agents']);

      const counts = manager.getChannelCounts();
      expect(counts.workflows).toBe(2);
      expect(counts.queue).toBe(1);
      expect(counts.agents).toBe(1);
    });
  });
});
