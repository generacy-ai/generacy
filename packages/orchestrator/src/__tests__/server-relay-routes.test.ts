/**
 * Tests for relay route wiring in initializeRelayBridge (#574).
 *
 * Verifies that the orchestrator passes a /control-plane route to the
 * relay client so cloud-sent /control-plane/* requests reach the
 * control-plane unix socket.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import type { FastifyInstance } from 'fastify';

const relayConstructorSpy = vi.fn().mockImplementation(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  send: vi.fn(),
  isConnected: false,
  on: vi.fn(),
  off: vi.fn(),
  onMessage: vi.fn(),
  pushEvent: vi.fn(),
  setMetadata: vi.fn(),
}));

// Mock cluster-relay to capture constructor args
vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: relayConstructorSpy,
}));

// Mock control-plane tunnel handler
vi.mock('@generacy-ai/control-plane', () => ({
  TunnelHandler: vi.fn().mockImplementation(() => ({})),
  getCodeServerManager: vi.fn().mockReturnValue(null),
}));

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

describe('initializeRelayBridge routes (#574)', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    vi.restoreAllMocks();
  });

  it('passes /control-plane route pointing to control-plane unix socket', async () => {
    const config = buildConfig({
      relay: {
        apiKey: 'test-api-key',
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });

    // RelayClientImpl should have been constructed with routes
    expect(relayConstructorSpy).toHaveBeenCalledTimes(1);
    const constructorArgs = relayConstructorSpy.mock.calls[0][0];
    expect(constructorArgs.routes).toEqual([
      {
        prefix: '/control-plane',
        target: 'unix:///run/generacy-control-plane/control.sock',
      },
    ]);
  }, 15_000);

  it('uses CONTROL_PLANE_SOCKET_PATH env var when set', async () => {
    const originalEnv = process.env['CONTROL_PLANE_SOCKET_PATH'];
    process.env['CONTROL_PLANE_SOCKET_PATH'] = '/custom/control-plane.sock';

    try {
      const config = buildConfig({
        relay: {
          apiKey: 'test-api-key',
          cloudUrl: 'wss://test.example.com/relay',
        } as any,
      });

      server = await createServer({ config });

      expect(relayConstructorSpy).toHaveBeenCalledTimes(1);
      const constructorArgs = relayConstructorSpy.mock.calls[0][0];
      expect(constructorArgs.routes).toEqual([
        {
          prefix: '/control-plane',
          target: 'unix:///custom/control-plane.sock',
        },
      ]);
    } finally {
      if (originalEnv === undefined) {
        delete process.env['CONTROL_PLANE_SOCKET_PATH'];
      } else {
        process.env['CONTROL_PLANE_SOCKET_PATH'] = originalEnv;
      }
    }
  }, 15_000);
});
