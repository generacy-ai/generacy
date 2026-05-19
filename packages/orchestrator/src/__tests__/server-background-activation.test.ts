/**
 * Tests for background activation in wizard mode (#567).
 *
 * T006: Server starts and /health responds while activation is pending.
 * T007: Relay bridge and conversation manager initialize after background activation succeeds.
 * T008: Server continues running after background activation failure.
 */

import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import type { FastifyInstance } from 'fastify';
import { activate } from '../activation/index.js';

// Mock the activate module
vi.mock('../activation/index.js', () => ({
  activate: vi.fn(),
}));

// Mock cluster-relay to avoid real connections
vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    isConnected: false,
  })),
}));

// Mock control-plane tunnel handler
vi.mock('@generacy-ai/control-plane', () => ({
  TunnelHandler: vi.fn().mockImplementation(() => ({})),
  getCodeServerManager: vi.fn().mockReturnValue(null),
}));

const activateMock = activate as Mock;

function buildConfig(overrides: Partial<Parameters<typeof createTestConfig>[0]> = {}) {
  return createTestConfig({
    server: { port: 0, host: '127.0.0.1' },
    redis: { url: 'redis://127.0.0.1:1' },
    auth: {
      enabled: false,
      providers: [],
      jwt: { secret: 'test-secret-at-least-32-characters-long', expiresIn: '1h' },
    },
    logging: { level: 'error', pretty: false },
    ...overrides,
  });
}

describe('T006: Server starts with pending activation', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
  });

  it('should bind port and respond to /health while activate() is still pending', async () => {
    // activate() returns a promise that never resolves
    activateMock.mockReturnValue(new Promise(() => {})); // never resolves

    const config = buildConfig({
      relay: {
        apiKey: undefined, // No API key → triggers activation
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(activateMock).toHaveBeenCalledTimes(1);
  }, 15_000);
});

describe('T007: Relay bridge initializes after background activation succeeds', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
  });

  it('should call initializeRelayBridge and start relay after activation resolves', async () => {
    let resolveActivation: (value: any) => void;
    const activationPromise = new Promise((resolve) => { resolveActivation = resolve; });

    activateMock.mockReturnValue(activationPromise);

    const config = buildConfig({
      relay: {
        apiKey: undefined,
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Server is running but activation hasn't completed yet
    const healthBefore = await server.inject({ method: 'GET', url: '/health' });
    expect(healthBefore.statusCode).toBe(200);

    // Resolve activation
    resolveActivation!({
      apiKey: 'test-api-key',
      clusterApiKeyId: 'test-key-id',
      clusterId: 'test-cluster',
      projectId: 'test-project',
      orgId: 'test-org',
      cloudUrl: 'https://test.example.com',
    });

    // Wait for background initialization to complete
    await vi.waitFor(() => {
      expect(config.relay.apiKey).toBe('test-api-key');
    }, { timeout: 5000 });

    // Config should be updated. The relay URL must include ?projectId=<id> —
    // the relay-server's auth middleware (generacy-cloud relay-auth.ts) rejects
    // connections without it as 401 "projectId query parameter required",
    // leaving the cluster permanently offline.
    expect(config.relay.clusterApiKeyId).toBe('test-key-id');
    expect(config.relay.cloudUrl).toBe(
      'wss://test.example.com/relay?projectId=test-project',
    );
  }, 15_000);
});

describe('T008: Server continues after activation failure', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
  });

  it('should log warning and keep serving when activation rejects', async () => {
    activateMock.mockRejectedValue(new Error('Activation timed out'));

    const config = buildConfig({
      relay: {
        apiKey: undefined,
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Wait for the rejected promise to be handled
    await vi.waitFor(() => {
      expect(activateMock).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Give the catch handler time to run
    await new Promise((r) => setTimeout(r, 100));

    // Server should still be responsive
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);

    // API key should NOT have been set (activation failed)
    expect(config.relay.apiKey).toBeUndefined();
  }, 15_000);
});
