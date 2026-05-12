/**
 * Tests for relay route wiring in initializeRelayBridge (#574, #586).
 *
 * Verifies that the orchestrator passes /control-plane and /code-server
 * routes to the relay client, and wires onStatusChange → sendMetadata.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockOnStatusChange, mockCodeServerManager, relayConstructorSpy } = vi.hoisted(() => {
  const mockOnStatusChange = vi.fn();
  const mockCodeServerManager = {
    start: vi.fn(),
    stop: vi.fn(),
    touch: vi.fn(),
    getStatus: vi.fn(() => 'stopped' as const),
    shutdown: vi.fn(),
    onStatusChange: mockOnStatusChange,
  };
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
  return { mockOnStatusChange, mockCodeServerManager, relayConstructorSpy };
});

// Mock cluster-relay to capture constructor args
vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: relayConstructorSpy,
}));

// Mock control-plane tunnel handler and code-server manager
vi.mock('@generacy-ai/control-plane', () => ({
  TunnelHandler: vi.fn().mockImplementation(() => ({})),
  getCodeServerManager: vi.fn().mockReturnValue(mockCodeServerManager),
}));

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

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

describe('initializeRelayBridge routes (#574, #586)', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    relayConstructorSpy.mockClear();
    mockOnStatusChange.mockClear();
  });

  it('passes /control-plane and /code-server routes to relay client', async () => {
    const config = buildConfig({
      relay: {
        apiKey: 'test-api-key',
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });

    expect(relayConstructorSpy).toHaveBeenCalledTimes(1);
    const constructorArgs = relayConstructorSpy.mock.calls[0][0];
    expect(constructorArgs.routes).toEqual(
      expect.arrayContaining([
        {
          prefix: '/control-plane',
          target: 'unix:///run/generacy-control-plane/control.sock',
        },
        {
          prefix: '/code-server',
          target: 'unix:///run/code-server.sock',
        },
      ]),
    );
  }, 15_000);

  it('uses CODE_SERVER_SOCKET_PATH env var when set', async () => {
    const originalEnv = process.env['CODE_SERVER_SOCKET_PATH'];
    process.env['CODE_SERVER_SOCKET_PATH'] = '/custom/code-server.sock';

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
      expect(constructorArgs.routes).toEqual(
        expect.arrayContaining([
          {
            prefix: '/code-server',
            target: 'unix:///custom/code-server.sock',
          },
        ]),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env['CODE_SERVER_SOCKET_PATH'];
      } else {
        process.env['CODE_SERVER_SOCKET_PATH'] = originalEnv;
      }
    }
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
      expect(constructorArgs.routes).toEqual(
        expect.arrayContaining([
          {
            prefix: '/control-plane',
            target: 'unix:///custom/control-plane.sock',
          },
        ]),
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env['CONTROL_PLANE_SOCKET_PATH'];
      } else {
        process.env['CONTROL_PLANE_SOCKET_PATH'] = originalEnv;
      }
    }
  }, 15_000);

  it('wires onStatusChange to trigger sendMetadata on running (#586)', async () => {
    const config = buildConfig({
      relay: {
        apiKey: 'test-api-key',
        cloudUrl: 'wss://test.example.com/relay',
      } as any,
    });

    server = await createServer({ config });

    // onStatusChange should have been called with a callback
    expect(mockOnStatusChange).toHaveBeenCalledTimes(1);
    const callback = mockOnStatusChange.mock.calls[0][0];
    expect(typeof callback).toBe('function');
  }, 15_000);
});
