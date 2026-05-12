import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupInternalRelayEventsRoute } from '../internal-relay-events.js';
import { createAuthMiddleware, InMemoryApiKeyStore } from '../../auth/index.js';
import type { ClusterRelayClient, RelayMessage } from '../../types/relay.js';

function createMockRelayClient(overrides: Partial<ClusterRelayClient> = {}): ClusterRelayClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: true,
    ...overrides,
  };
}

describe('POST /internal/relay-events', () => {
  let server: FastifyInstance;
  let relayClient: ClusterRelayClient;
  let apiKeyStore: InMemoryApiKeyStore;
  const testApiKey = 'test-internal-key-uuid';

  beforeEach(async () => {
    server = Fastify();
    relayClient = createMockRelayClient();
    apiKeyStore = new InMemoryApiKeyStore();
    apiKeyStore.addKey(testApiKey, {
      name: 'control-plane-internal',
      scopes: ['admin'],
      createdAt: new Date().toISOString(),
    });

    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    server.addHook('preHandler', authMiddleware);

    setupInternalRelayEventsRoute(server, relayClient);
    await server.ready();
  });

  it('forwards a valid event to the relay client and returns 204', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      headers: { authorization: `Bearer ${testApiKey}` },
      payload: {
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'starting' },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(relayClient.send).toHaveBeenCalledWith({
      type: 'event',
      channel: 'cluster.vscode-tunnel',
      event: { status: 'starting' },
    });
  });

  it('accepts all allowed channels', async () => {
    for (const channel of ['cluster.audit', 'cluster.credentials', 'cluster.bootstrap']) {
      const response = await server.inject({
        method: 'POST',
        url: '/internal/relay-events',
        headers: { authorization: `Bearer ${testApiKey}` },
        payload: { channel, payload: { test: true } },
      });
      expect(response.statusCode).toBe(204);
    }
    expect(relayClient.send).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid channel with 400', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      headers: { authorization: `Bearer ${testApiKey}` },
      payload: {
        channel: 'not.a.real.channel',
        payload: {},
      },
    });

    expect(response.statusCode).toBe(400);
    expect(relayClient.send).not.toHaveBeenCalled();
  });

  it('rejects a request with missing channel', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      headers: { authorization: `Bearer ${testApiKey}` },
      payload: { payload: {} },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 401 without an API key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      payload: {
        channel: 'cluster.vscode-tunnel',
        payload: {},
      },
    });

    expect(response.statusCode).toBe(401);
    expect(relayClient.send).not.toHaveBeenCalled();
  });

  it('returns 401 with an invalid API key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/relay-events',
      headers: { authorization: 'Bearer wrong-key' },
      payload: {
        channel: 'cluster.vscode-tunnel',
        payload: {},
      },
    });

    expect(response.statusCode).toBe(401);
    expect(relayClient.send).not.toHaveBeenCalled();
  });

  it('returns 204 even when relay client is disconnected (no-op send)', async () => {
    relayClient = createMockRelayClient({ isConnected: false });
    const disconnectedServer = Fastify();
    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    disconnectedServer.addHook('preHandler', authMiddleware);
    setupInternalRelayEventsRoute(disconnectedServer, relayClient);
    await disconnectedServer.ready();

    const response = await disconnectedServer.inject({
      method: 'POST',
      url: '/internal/relay-events',
      headers: { authorization: `Bearer ${testApiKey}` },
      payload: {
        channel: 'cluster.vscode-tunnel',
        payload: { status: 'starting' },
      },
    });

    expect(response.statusCode).toBe(204);
    expect(relayClient.send).not.toHaveBeenCalled();
  });
});
