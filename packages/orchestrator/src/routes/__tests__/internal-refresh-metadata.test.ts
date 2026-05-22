import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { setupInternalRefreshMetadataRoute } from '../internal-refresh-metadata.js';
import { createAuthMiddleware, InMemoryApiKeyStore } from '../../auth/index.js';
import type { RelayBridge } from '../../services/relay-bridge.js';

function createMockRelayBridge(overrides: Partial<RelayBridge> = {}): RelayBridge {
  return {
    sendMetadata: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as RelayBridge;
}

describe('POST /internal/refresh-metadata', () => {
  let server: FastifyInstance;
  let relayBridge: RelayBridge;
  let apiKeyStore: InMemoryApiKeyStore;
  const testApiKey = 'test-internal-key-uuid';

  beforeEach(async () => {
    server = Fastify();
    relayBridge = createMockRelayBridge();
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

    setupInternalRefreshMetadataRoute(server, () => relayBridge);
    await server.ready();
  });

  it('returns 200 and calls sendMetadata when bridge is available', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/refresh-metadata',
      headers: { authorization: `Bearer ${testApiKey}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toEqual({ accepted: true });
    expect(relayBridge.sendMetadata).toHaveBeenCalledOnce();
  });

  it('returns 503 when relay bridge is not yet initialized', async () => {
    const noServer = Fastify();
    const authMiddleware = createAuthMiddleware({
      apiKeyStore,
      enabled: true,
      skipRoutes: ['/health'],
    });
    noServer.addHook('preHandler', authMiddleware);
    setupInternalRefreshMetadataRoute(noServer, () => null);
    await noServer.ready();

    const response = await noServer.inject({
      method: 'POST',
      url: '/internal/refresh-metadata',
      headers: { authorization: `Bearer ${testApiKey}` },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('relay bridge not yet initialized');
  });

  it('returns 401 without an API key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/refresh-metadata',
    });

    expect(response.statusCode).toBe(401);
    expect(relayBridge.sendMetadata).not.toHaveBeenCalled();
  });

  it('returns 401 with an invalid API key', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/internal/refresh-metadata',
      headers: { authorization: 'Bearer wrong-key' },
    });

    expect(response.statusCode).toBe(401);
    expect(relayBridge.sendMetadata).not.toHaveBeenCalled();
  });
});
