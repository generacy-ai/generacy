import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageRouter } from '../../src/router/message-router.js';
import { createMockAgencyConnection } from '../../src/connections/agency-connection.js';
import { createMockHumancyConnection } from '../../src/connections/humancy-connection.js';
import type { MessageEnvelope } from '../../src/types/messages.js';
import { DestinationNotFoundError, NoRecipientsError } from '../../src/router/routing-rules.js';

describe('MessageRouter', () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
  });

  describe('registration', () => {
    it('registers an agency connection', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);

      const registry = router.getConnectionRegistry();
      expect(registry.hasAgency('agency-1')).toBe(true);
    });

    it('registers a humancy connection', () => {
      const { connection } = createMockHumancyConnection('humancy-1');
      router.registerHumancy(connection);

      const registry = router.getConnectionRegistry();
      expect(registry.hasHumancy('humancy-1')).toBe(true);
    });

    it('unregisters connections', () => {
      const { connection: agency } = createMockAgencyConnection('agency-1');
      const { connection: humancy } = createMockHumancyConnection('humancy-1');

      router.registerAgency(agency);
      router.registerHumancy(humancy);
      router.unregister('agency-1');
      router.unregister('humancy-1');

      const registry = router.getConnectionRegistry();
      expect(registry.hasAgency('agency-1')).toBe(false);
      expect(registry.hasHumancy('humancy-1')).toBe(false);
    });
  });

  describe('routing', () => {
    it('routes mode_command to agency', async () => {
      const { connection, receivedMessages } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(receivedMessages).toContain(message);
    });

    it('throws when agency destination not found', async () => {
      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'non-existent' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await expect(router.route(message)).rejects.toThrow(DestinationNotFoundError);
    });

    it('routes decision_response to agency via destination', async () => {
      const { connection, receivedMessages } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'decision_response',
        correlationId: 'corr-1',
        source: { type: 'humancy', id: 'humancy-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { approved: true },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(receivedMessages).toContain(message);
    });

    it('routes channel_message via channel router', async () => {
      const channelRouter = vi.fn().mockResolvedValue(undefined);
      router.channelRouter = channelRouter;

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'channel_message',
        channel: 'notifications',
        source: { type: 'agency', id: 'agency-1' },
        payload: { notification: 'test' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(channelRouter).toHaveBeenCalledWith(message);
    });

    it('throws when channel router not configured', async () => {
      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'channel_message',
        channel: 'notifications',
        source: { type: 'agency', id: 'agency-1' },
        payload: { notification: 'test' },
        meta: { timestamp: Date.now() },
      };

      await expect(router.route(message)).rejects.toThrow('Channel routing not configured');
    });
  });

  describe('broadcasting', () => {
    it('broadcasts decision_request to all humancy', async () => {
      const { connection: h1, receivedMessages: received1 } = createMockHumancyConnection('humancy-1');
      const { connection: h2, receivedMessages: received2 } = createMockHumancyConnection('humancy-2');

      router.registerHumancy(h1);
      router.registerHumancy(h2);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(received1).toContain(message);
      expect(received2).toContain(message);
    });

    it('broadcasts workflow_event to all humancy', async () => {
      const { connection: h1, receivedMessages: received1 } = createMockHumancyConnection('humancy-1');
      const { connection: h2, receivedMessages: received2 } = createMockHumancyConnection('humancy-2');

      router.registerHumancy(h1);
      router.registerHumancy(h2);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'workflow_event',
        source: { type: 'router', id: 'router-1' },
        payload: { event: 'completed' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(received1).toContain(message);
      expect(received2).toContain(message);
    });

    it('throws when no humancy registered for broadcast', async () => {
      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      await expect(router.route(message)).rejects.toThrow(NoRecipientsError);
    });

    it('broadcasts to agencies', async () => {
      const { connection: a1, receivedMessages: received1 } = createMockAgencyConnection('agency-1');
      const { connection: a2, receivedMessages: received2 } = createMockAgencyConnection('agency-2');

      router.registerAgency(a1);
      router.registerAgency(a2);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'workflow_event',
        source: { type: 'router', id: 'router-1' },
        payload: { event: 'pause_all' },
        meta: { timestamp: Date.now() },
      };

      await router.broadcastToAgencies(message);

      expect(received1).toContain(message);
      expect(received2).toContain(message);
    });
  });

  describe('events', () => {
    it('emits message:routed event', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);

      const routedHandler = vi.fn();
      router.on('message:routed', routedHandler);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(routedHandler).toHaveBeenCalledWith(message, 'agency:agency-1');
    });

    it('emits message:broadcast event', async () => {
      const { connection: h1 } = createMockHumancyConnection('humancy-1');
      const { connection: h2 } = createMockHumancyConnection('humancy-2');

      router.registerHumancy(h1);
      router.registerHumancy(h2);

      const broadcastHandler = vi.fn();
      router.on('message:broadcast', broadcastHandler);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(broadcastHandler).toHaveBeenCalledWith(
        message,
        expect.arrayContaining(['humancy:humancy-1', 'humancy:humancy-2'])
      );
    });

    it('removes event listeners with off()', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);

      const routedHandler = vi.fn();
      router.on('message:routed', routedHandler);
      router.off('message:routed', routedHandler);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(routedHandler).not.toHaveBeenCalled();
    });
  });

  describe('message queuing', () => {
    it('queues message when recipient offline', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      router.registerAgency(connection);
      router.getConnectionRegistry().markAgencyOffline('agency-1');

      const enqueue = vi.fn().mockResolvedValue(undefined);
      router.messageQueue = { enqueue };

      const queuedHandler = vi.fn();
      router.on('message:queued', queuedHandler);

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'mode_command',
        source: { type: 'router', id: 'router-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { mode: 'pause' },
        meta: { timestamp: Date.now() },
      };

      await router.route(message);

      expect(enqueue).toHaveBeenCalledWith('agency', 'agency-1', message);
      expect(queuedHandler).toHaveBeenCalledWith(message, 'agency:agency-1');
    });
  });

  describe('routeAndWait', () => {
    it('throws when correlation manager not configured', async () => {
      const message: MessageEnvelope = {
        id: 'msg-1',
        correlationId: 'corr-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      await expect(router.routeAndWait(message, 5000)).rejects.toThrow(
        'Correlation manager not configured'
      );
    });

    it('throws when message has no correlationId', async () => {
      router.correlationManager = {
        correlate: vi.fn(),
        waitForCorrelation: vi.fn(),
      };

      const message: MessageEnvelope = {
        id: 'msg-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      await expect(router.routeAndWait(message, 5000)).rejects.toThrow(
        'routeAndWait requires correlationId'
      );
    });

    it('routes and waits for correlation', async () => {
      const { connection: h1 } = createMockHumancyConnection('humancy-1');
      router.registerHumancy(h1);

      const response: MessageEnvelope = {
        id: 'resp-1',
        correlationId: 'corr-1',
        type: 'decision_response',
        source: { type: 'humancy', id: 'humancy-1' },
        destination: { type: 'agency', id: 'agency-1' },
        payload: { approved: true },
        meta: { timestamp: Date.now() },
      };

      router.correlationManager = {
        correlate: vi.fn(),
        waitForCorrelation: vi.fn().mockResolvedValue(response),
      };

      const message: MessageEnvelope = {
        id: 'msg-1',
        correlationId: 'corr-1',
        type: 'decision_request',
        source: { type: 'agency', id: 'agency-1' },
        payload: { question: 'approve?' },
        meta: { timestamp: Date.now() },
      };

      const result = await router.routeAndWait(message, 5000);

      expect(result).toBe(response);
      expect(router.correlationManager.waitForCorrelation).toHaveBeenCalledWith('corr-1', 5000);
    });
  });

  describe('stats', () => {
    it('returns connection statistics', () => {
      const { connection: a1 } = createMockAgencyConnection('agency-1');
      const { connection: h1 } = createMockHumancyConnection('humancy-1');
      const { connection: h2 } = createMockHumancyConnection('humancy-2');

      router.registerAgency(a1);
      router.registerHumancy(h1);
      router.registerHumancy(h2);

      const stats = router.getStats();

      expect(stats.connections.agencies.total).toBe(1);
      expect(stats.connections.agencies.online).toBe(1);
      expect(stats.connections.humancy.total).toBe(2);
      expect(stats.connections.humancy.online).toBe(2);
    });
  });

  describe('cleanup', () => {
    it('closes all connections', async () => {
      const { connection: a1 } = createMockAgencyConnection('agency-1');
      const { connection: h1 } = createMockHumancyConnection('humancy-1');

      router.registerAgency(a1);
      router.registerHumancy(h1);

      await router.close();

      const registry = router.getConnectionRegistry();
      expect(registry.hasAgency('agency-1')).toBe(false);
      expect(registry.hasHumancy('humancy-1')).toBe(false);
    });
  });
});
