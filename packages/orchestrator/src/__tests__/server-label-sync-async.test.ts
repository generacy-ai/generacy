/**
 * Label sync must not block server.listen().
 *
 * A wizard cluster restarts itself once after post-activation so entrypoints
 * re-run with the repo present. On that restart the label monitor is enabled
 * and `LabelSyncService.syncAll` walks dozens of sequential GitHub label
 * create/update calls (~30s on a fresh repo). Previously this was `await`ed
 * before `server.listen()`, so the orchestrator — and therefore the relay and
 * the cloud bootstrap UI — stayed unreachable for the full sync duration.
 *
 * Label sync now runs fire-and-forget in the onReady hook. These tests pin that
 * contract: the server binds and serves /health even while syncAll is pending
 * or has rejected.
 */

import { describe, it, expect, afterEach, vi, type Mock } from 'vitest';
import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';
import type { FastifyInstance } from 'fastify';
import { activate } from '../activation/index.js';
import { LabelSyncService } from '../services/label-sync-service.js';

// Controllable syncAll so each test drives the pending / rejected states.
const syncAllMock = vi.fn();
vi.mock('../services/label-sync-service.js', () => ({
  LabelSyncService: vi.fn().mockImplementation(() => ({
    syncAll: syncAllMock,
  })),
}));

// Mock activate so the wizard-mode activation path never resolves (relay bridge
// stays uninitialized) — mirrors server-background-activation.test.ts.
vi.mock('../activation/index.js', () => ({
  activate: vi.fn(),
}));

// Avoid real relay / control-plane connections.
vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    isConnected: false,
  })),
}));
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
    // repositories.length > 0 activates the label-sync path; labelMonitor stays
    // false (its default) so no monitor makes real GitHub calls.
    repositories: [{ owner: 'acme', repo: 'widget' }],
    relay: {
      apiKey: undefined, // triggers (mocked) background activation
      cloudUrl: 'wss://test.example.com/relay',
    } as any,
    ...overrides,
  });
}

describe('Label sync is fire-and-forget (does not block listen)', () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
    // Clear call history only — restoreAllMocks would wipe the LabelSyncService
    // class mock implementation, breaking `new LabelSyncService()` in later tests.
    syncAllMock.mockClear();
    activateMock.mockClear();
  });

  it('binds and serves /health while syncAll is still pending', async () => {
    activateMock.mockReturnValue(new Promise(() => {})); // never resolves
    // syncAll never resolves: if it were awaited before listen, createServer /
    // listen would hang and this test would time out.
    syncAllMock.mockReturnValue(new Promise(() => {}));

    server = await createServer({ config: buildConfig() });
    await server.listen({ port: 0, host: '127.0.0.1' });

    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    // Kicked off after the server became ready (fire-and-forget).
    await vi.waitFor(() => {
      expect(syncAllMock).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });
  }, 15_000);

  it('keeps serving /health when syncAll rejects', async () => {
    activateMock.mockReturnValue(new Promise(() => {}));
    syncAllMock.mockRejectedValue(new Error('GitHub label API failed'));

    server = await createServer({ config: buildConfig() });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(syncAllMock).toHaveBeenCalledTimes(1);
    }, { timeout: 2000 });

    // Give the rejection handler a tick to run.
    await new Promise((r) => setTimeout(r, 100));

    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  }, 15_000);
});
