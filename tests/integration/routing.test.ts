import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageRouter,
  CorrelationManager,
  createMockAgencyConnection,
  createMockHumancyConnection,
  ChannelRegistry,
  ChannelMessageHandler,
} from '../../src/index.js';
import type { MessageEnvelope, ChannelHandler } from '../../src/types/index.js';
import { v4 as uuid } from 'uuid';

describe('Integration: Complete Routing Scenarios', () => {
  let router: MessageRouter;
  let correlationManager: CorrelationManager;

  beforeEach(() => {
    router = new MessageRouter();
    correlationManager = new CorrelationManager();
    router.correlationManager = correlationManager;
  });

  describe('Agency <-> Humancy routing', () => {
    it('routes decision_request from agency to all humancy and back', async () => {
      // Setup connections
      const { connection: agency, receivedMessages: agencyReceived } =
        createMockAgencyConnection('agency-1');
      const { connection: humancy1, receivedMessages: humancy1Received } =
        createMockHumancyConnection('humancy-1', 'vscode');
      const { connection: humancy2, receivedMessages: humancy2Received } =
        createMockHumancyConnection('humancy-2', 'cloud');

      router.registerAgency(agency);
      router.registerHumancy(humancy1);
      router.registerHumancy(humancy2);

      // Agency sends decision request
      const request: MessageEnvelope = {
        id: uuid(),
        correlationId: uuid(),
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'Should I proceed?', options: ['Yes', 'No'] },
        meta: { timestamp: Date.now() },
      };

      await router.route(request);

      // Both humancy instances should receive the request
      expect(humancy1Received).toHaveLength(1);
      expect(humancy2Received).toHaveLength(1);
      expect(humancy1Received[0]?.payload).toEqual(request.payload);
      expect(humancy2Received[0]?.payload).toEqual(request.payload);

      // Humancy responds
      const response: MessageEnvelope = {
        id: uuid(),
        correlationId: request.correlationId,
        type: 'decision_response',
        source: { type: 'humancy', id: 'humancy-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { decision: 'Yes', reason: 'Approved' },
        meta: { timestamp: Date.now() },
      };

      await router.route(response);

      // Agency should receive the response
      expect(agencyReceived).toHaveLength(1);
      expect(agencyReceived[0]?.correlationId).toBe(request.correlationId);
      expect(agencyReceived[0]?.payload).toEqual({ decision: 'Yes', reason: 'Approved' });
    });

    it('routes mode_command from router to specific agency', async () => {
      const { connection: agency1, receivedMessages: agency1Received } =
        createMockAgencyConnection('agency-1');
      const { connection: agency2, receivedMessages: agency2Received } =
        createMockAgencyConnection('agency-2');

      router.registerAgency(agency1);
      router.registerAgency(agency2);

      const command: MessageEnvelope = {
        id: uuid(),
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause', reason: 'User requested pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(command);

      // Only agency-1 should receive the command
      expect(agency1Received).toHaveLength(1);
      expect(agency2Received).toHaveLength(0);
      expect(agency1Received[0]?.payload).toEqual(command.payload);
    });

    it('broadcasts workflow_event to all humancy instances', async () => {
      const { connection: humancy1, receivedMessages: humancy1Received } =
        createMockHumancyConnection('humancy-1', 'vscode');
      const { connection: humancy2, receivedMessages: humancy2Received } =
        createMockHumancyConnection('humancy-2', 'cloud');
      const { connection: humancy3, receivedMessages: humancy3Received } =
        createMockHumancyConnection('humancy-3', 'vscode');

      router.registerHumancy(humancy1);
      router.registerHumancy(humancy2);
      router.registerHumancy(humancy3);

      const event: MessageEnvelope = {
        id: uuid(),
        type: 'workflow_event',
        source: { type: 'router', id: 'router-1' },
        payload: { event: 'task_completed', taskId: 'task-123' },
        meta: { timestamp: Date.now() },
      };

      await router.route(event);

      // All humancy instances should receive the event
      expect(humancy1Received).toHaveLength(1);
      expect(humancy2Received).toHaveLength(1);
      expect(humancy3Received).toHaveLength(1);
    });
  });

  describe('routeAndWait correlation', () => {
    it('waits for correlated response', async () => {
      vi.useFakeTimers();

      const { connection: agency } = createMockAgencyConnection('agency-1');
      const { connection: humancy, receivedMessages } = createMockHumancyConnection('humancy-1');

      router.registerAgency(agency);
      router.registerHumancy(humancy);

      const request: MessageEnvelope = {
        id: uuid(),
        correlationId: uuid(),
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'Confirm?' },
        meta: { timestamp: Date.now() },
      };

      // Start waiting for response
      const responsePromise = router.routeAndWait(request, 5000);

      // Humancy receives request and responds
      await vi.advanceTimersByTimeAsync(100);
      expect(receivedMessages).toHaveLength(1);

      const response: MessageEnvelope = {
        id: uuid(),
        correlationId: request.correlationId,
        type: 'decision_response',
        source: { type: 'humancy', id: 'humancy-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { confirmed: true },
        meta: { timestamp: Date.now() },
      };

      // Correlate the response
      correlationManager.correlate(request.correlationId!, response);

      const result = await responsePromise;
      expect(result.payload).toEqual({ confirmed: true });

      vi.useRealTimers();
    });
  });

  describe('channel routing', () => {
    it('routes channel messages to registered handlers', async () => {
      const channelRegistry = new ChannelRegistry();
      const channelHandler = new ChannelMessageHandler(channelRegistry);

      // Register a channel handler
      const notificationHandler: ChannelHandler = vi.fn();
      channelRegistry.register('notifications', notificationHandler, 'notification-plugin');

      // Connect channel handler to router
      router.channelRouter = async (message) => {
        await channelHandler.handle(message);
      };

      const message: MessageEnvelope = {
        id: uuid(),
        type: 'channel_message',
        channel: 'notifications',
        source: { type: 'agency', id: 'agency-1' },
        payload: { title: 'Alert', body: 'Something happened' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(notificationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ payload: message.payload }),
        expect.any(Object)
      );
    });
  });

  describe('offline queuing', () => {
    it('queues messages for offline recipients', async () => {
      const { connection: agency } = createMockAgencyConnection('agency-1');
      router.registerAgency(agency);

      // Mark agency as offline
      router.getConnectionRegistry().markAgencyOffline('agency-1');

      // Set up mock message queue
      const enqueuedMessages: MessageEnvelope[] = [];
      router.messageQueue = {
        enqueue: async (_type, _id, message) => {
          enqueuedMessages.push(message);
        },
      };

      const command: MessageEnvelope = {
        id: uuid(),
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(command);

      expect(enqueuedMessages).toHaveLength(1);
      expect(enqueuedMessages[0]?.payload).toEqual({ mode: 'pause' });
    });
  });

  describe('event emissions', () => {
    it('emits message:routed for direct routing', async () => {
      const { connection: agency } = createMockAgencyConnection('agency-1');
      router.registerAgency(agency);

      const routedHandler = vi.fn();
      router.on('message:routed', routedHandler);

      const command: MessageEnvelope = {
        id: uuid(),
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'resume' },
        meta: { timestamp: Date.now() },
      };

      await router.route(command);

      expect(routedHandler).toHaveBeenCalledWith(command, 'agency:agency-1');
    });

    it('emits message:broadcast for broadcast routing', async () => {
      const { connection: humancy1 } = createMockHumancyConnection('humancy-1');
      const { connection: humancy2 } = createMockHumancyConnection('humancy-2');

      router.registerHumancy(humancy1);
      router.registerHumancy(humancy2);

      const broadcastHandler = vi.fn();
      router.on('message:broadcast', broadcastHandler);

      const request: MessageEnvelope = {
        id: uuid(),
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'Test?' },
        meta: { timestamp: Date.now() },
      };

      await router.route(request);

      expect(broadcastHandler).toHaveBeenCalledWith(
        request,
        expect.arrayContaining(['humancy:humancy-1', 'humancy:humancy-2'])
      );
    });
  });

  describe('connection lifecycle', () => {
    it('handles connection disconnect', async () => {
      const { connection: agency, triggerDisconnect } = createMockAgencyConnection('agency-1');
      router.registerAgency(agency);

      expect(router.getConnectionRegistry().getStatus('agency', 'agency-1')).toBe('online');

      triggerDisconnect();

      expect(router.getConnectionRegistry().getStatus('agency', 'agency-1')).toBe('offline');
    });

    it('reconnect triggers message delivery callback', async () => {
      const { connection: agency } = createMockAgencyConnection('agency-1');
      router.registerAgency(agency);

      const registry = router.getConnectionRegistry();
      const deliveryCallback = vi.fn().mockResolvedValue(undefined);
      registry.onReconnectDelivery = deliveryCallback;

      // Simulate disconnect and reconnect
      registry.markAgencyOffline('agency-1');
      await registry.markAgencyOnline('agency-1');

      expect(deliveryCallback).toHaveBeenCalledWith('agency', 'agency-1');
    });
  });

  describe('stats', () => {
    it('reports accurate connection stats', () => {
      const { connection: agency1 } = createMockAgencyConnection('agency-1');
      const { connection: agency2 } = createMockAgencyConnection('agency-2');
      const { connection: humancy1 } = createMockHumancyConnection('humancy-1');

      router.registerAgency(agency1);
      router.registerAgency(agency2);
      router.registerHumancy(humancy1);

      router.getConnectionRegistry().markAgencyOffline('agency-1');

      const stats = router.getStats();

      expect(stats.connections.agencies.total).toBe(2);
      expect(stats.connections.agencies.online).toBe(1);
      expect(stats.connections.agencies.offline).toBe(1);
      expect(stats.connections.humancy.total).toBe(1);
      expect(stats.connections.humancy.online).toBe(1);
    });
  });

  describe('cleanup', () => {
    it('closes all connections on router.close()', async () => {
      const { connection: agency } = createMockAgencyConnection('agency-1');
      const { connection: humancy } = createMockHumancyConnection('humancy-1');

      router.registerAgency(agency);
      router.registerHumancy(humancy);

      await router.close();

      expect(router.getConnectionRegistry().hasAgency('agency-1')).toBe(false);
      expect(router.getConnectionRegistry().hasHumancy('humancy-1')).toBe(false);
    });
  });
});
