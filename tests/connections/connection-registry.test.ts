import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConnectionRegistry,
  ConnectionExistsError,
  ConnectionNotFoundError,
} from '../../src/connections/connection-registry.js';
import { createMockAgencyConnection } from '../../src/connections/agency-connection.js';
import { createMockHumancyConnection } from '../../src/connections/humancy-connection.js';

describe('ConnectionRegistry', () => {
  let registry: ConnectionRegistry;

  beforeEach(() => {
    registry = new ConnectionRegistry();
  });

  describe('agency registration', () => {
    it('registers an agency connection', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      registry.registerAgency(connection);

      expect(registry.hasAgency('agency-1')).toBe(true);
      expect(registry.getAgency('agency-1')).toBeDefined();
      expect(registry.getAgency('agency-1')?.status).toBe('online');
    });

    it('throws when registering duplicate agency', () => {
      const { connection: conn1 } = createMockAgencyConnection('agency-1');
      const { connection: conn2 } = createMockAgencyConnection('agency-1');

      registry.registerAgency(conn1);
      expect(() => registry.registerAgency(conn2)).toThrow(ConnectionExistsError);
    });

    it('unregisters an agency connection', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      registry.registerAgency(connection);
      registry.unregisterAgency('agency-1');

      expect(registry.hasAgency('agency-1')).toBe(false);
    });

    it('throws when unregistering non-existent agency', () => {
      expect(() => registry.unregisterAgency('non-existent')).toThrow(ConnectionNotFoundError);
    });

    it('emits events on registration', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const registeredHandler = vi.fn();
      registry.on('agency:registered', registeredHandler);

      registry.registerAgency(connection);

      expect(registeredHandler).toHaveBeenCalledWith('agency-1', connection);
    });

    it('emits events on unregistration', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const unregisteredHandler = vi.fn();
      registry.on('agency:unregistered', unregisteredHandler);

      registry.registerAgency(connection);
      registry.unregisterAgency('agency-1');

      expect(unregisteredHandler).toHaveBeenCalledWith('agency-1');
    });
  });

  describe('humancy registration', () => {
    it('registers a humancy connection', () => {
      const { connection } = createMockHumancyConnection('humancy-1', 'vscode');
      registry.registerHumancy(connection);

      expect(registry.hasHumancy('humancy-1')).toBe(true);
      expect(registry.getHumancy('humancy-1')).toBeDefined();
      expect(registry.getHumancy('humancy-1')?.status).toBe('online');
    });

    it('throws when registering duplicate humancy', () => {
      const { connection: conn1 } = createMockHumancyConnection('humancy-1');
      const { connection: conn2 } = createMockHumancyConnection('humancy-1');

      registry.registerHumancy(conn1);
      expect(() => registry.registerHumancy(conn2)).toThrow(ConnectionExistsError);
    });

    it('unregisters a humancy connection', () => {
      const { connection } = createMockHumancyConnection('humancy-1');
      registry.registerHumancy(connection);
      registry.unregisterHumancy('humancy-1');

      expect(registry.hasHumancy('humancy-1')).toBe(false);
    });
  });

  describe('offline/online status', () => {
    it('marks agency offline', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const offlineHandler = vi.fn();
      registry.on('agency:offline', offlineHandler);

      registry.registerAgency(connection);
      registry.markAgencyOffline('agency-1');

      expect(registry.getAgency('agency-1')?.status).toBe('offline');
      expect(offlineHandler).toHaveBeenCalledWith('agency-1');
    });

    it('marks agency online', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const onlineHandler = vi.fn();
      registry.on('agency:online', onlineHandler);

      registry.registerAgency(connection);
      registry.markAgencyOffline('agency-1');
      await registry.markAgencyOnline('agency-1');

      expect(registry.getAgency('agency-1')?.status).toBe('online');
      expect(onlineHandler).toHaveBeenCalledWith('agency-1');
    });

    it('triggers onReconnectDelivery when marked online', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const deliveryCallback = vi.fn().mockResolvedValue(undefined);
      registry.onReconnectDelivery = deliveryCallback;

      registry.registerAgency(connection);
      registry.markAgencyOffline('agency-1');
      await registry.markAgencyOnline('agency-1');

      expect(deliveryCallback).toHaveBeenCalledWith('agency', 'agency-1');
    });

    it('auto-marks offline on disconnect event', () => {
      const { connection, triggerDisconnect } = createMockAgencyConnection('agency-1');
      registry.registerAgency(connection);

      triggerDisconnect();

      expect(registry.getAgency('agency-1')?.status).toBe('offline');
    });

    it('does not emit when already offline', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const offlineHandler = vi.fn();
      registry.on('agency:offline', offlineHandler);

      registry.registerAgency(connection);
      registry.markAgencyOffline('agency-1');
      registry.markAgencyOffline('agency-1'); // Second call

      expect(offlineHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOnline methods', () => {
    it('returns only online agencies', () => {
      const { connection: conn1 } = createMockAgencyConnection('agency-1');
      const { connection: conn2 } = createMockAgencyConnection('agency-2');
      const { connection: conn3 } = createMockAgencyConnection('agency-3');

      registry.registerAgency(conn1);
      registry.registerAgency(conn2);
      registry.registerAgency(conn3);
      registry.markAgencyOffline('agency-2');

      const online = registry.getOnlineAgencies();
      expect(online).toHaveLength(2);
      expect(online.map(r => r.connection.id)).toContain('agency-1');
      expect(online.map(r => r.connection.id)).toContain('agency-3');
    });

    it('returns only online humancy instances', () => {
      const { connection: conn1 } = createMockHumancyConnection('humancy-1');
      const { connection: conn2 } = createMockHumancyConnection('humancy-2');

      registry.registerHumancy(conn1);
      registry.registerHumancy(conn2);
      registry.markHumancyOffline('humancy-1');

      const online = registry.getOnlineHumancyInstances();
      expect(online).toHaveLength(1);
      expect(online[0]?.connection.id).toBe('humancy-2');
    });
  });

  describe('sendTo', () => {
    it('sends message to online connection', async () => {
      const { connection, receivedMessages } = createMockAgencyConnection('agency-1');
      registry.registerAgency(connection);

      const message = {
        id: 'msg-1',
        type: 'mode_command' as const,
        source: { type: 'router' as const, id: 'router-1' },
        payload: { command: 'test' },
        meta: { timestamp: Date.now() },
      };

      const result = await registry.sendTo('agency', 'agency-1', message);

      expect(result).toBe(true);
      expect(receivedMessages).toContain(message);
    });

    it('returns false for offline connection', async () => {
      const { connection } = createMockAgencyConnection('agency-1');
      registry.registerAgency(connection);
      registry.markAgencyOffline('agency-1');

      const message = {
        id: 'msg-1',
        type: 'mode_command' as const,
        source: { type: 'router' as const, id: 'router-1' },
        payload: { command: 'test' },
        meta: { timestamp: Date.now() },
      };

      const result = await registry.sendTo('agency', 'agency-1', message);

      expect(result).toBe(false);
    });

    it('returns false for non-existent connection', async () => {
      const message = {
        id: 'msg-1',
        type: 'mode_command' as const,
        source: { type: 'router' as const, id: 'router-1' },
        payload: { command: 'test' },
        meta: { timestamp: Date.now() },
      };

      const result = await registry.sendTo('agency', 'non-existent', message);

      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('returns correct statistics', () => {
      const { connection: a1 } = createMockAgencyConnection('a1');
      const { connection: a2 } = createMockAgencyConnection('a2');
      const { connection: h1 } = createMockHumancyConnection('h1');
      const { connection: h2 } = createMockHumancyConnection('h2');
      const { connection: h3 } = createMockHumancyConnection('h3');

      registry.registerAgency(a1);
      registry.registerAgency(a2);
      registry.registerHumancy(h1);
      registry.registerHumancy(h2);
      registry.registerHumancy(h3);

      registry.markAgencyOffline('a1');
      registry.markHumancyOffline('h1');
      registry.markHumancyOffline('h2');

      const stats = registry.getStats();

      expect(stats.agencies.total).toBe(2);
      expect(stats.agencies.online).toBe(1);
      expect(stats.agencies.offline).toBe(1);
      expect(stats.humancy.total).toBe(3);
      expect(stats.humancy.online).toBe(1);
      expect(stats.humancy.offline).toBe(2);
    });
  });

  describe('closeAll', () => {
    it('closes all connections and clears registry', async () => {
      const { connection: a1 } = createMockAgencyConnection('a1');
      const { connection: h1 } = createMockHumancyConnection('h1');

      registry.registerAgency(a1);
      registry.registerHumancy(h1);

      await registry.closeAll();

      expect(registry.hasAgency('a1')).toBe(false);
      expect(registry.hasHumancy('h1')).toBe(false);
    });
  });

  describe('event listener management', () => {
    it('removes event listeners with off()', () => {
      const { connection } = createMockAgencyConnection('agency-1');
      const handler = vi.fn();

      registry.on('agency:registered', handler);
      registry.off('agency:registered', handler);
      registry.registerAgency(connection);

      expect(handler).not.toHaveBeenCalled();
    });
  });
});
