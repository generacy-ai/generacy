/**
 * #972 SC-002 anchor: guards against a future refactor that drops one of the
 * two loud-failure signals (relay `cluster.bootstrap` event OR degraded
 * cluster status transition) on a webhook-registration 403.
 *
 * Boots createServer() in-process with:
 * - A preset smee channel URL (skips the async resolver; syncs webhook
 *   pipeline construction inside createServer).
 * - A single monitored repo.
 * - A mocked `@generacy-ai/cluster-relay` whose `send()` we spy on.
 * - A mocked `executeCommand` that returns HTTP 403 for the repo-hook list.
 * - A real Unix-domain HTTP server on a temp socket path, exposed via
 *   `CONTROL_PLANE_SOCKET_PATH`, to capture `POST /internal/status`.
 *
 * Asserts:
 * 1. Exactly one `EventMessage` where `event === 'cluster.bootstrap'` and
 *    `data.reason === 'webhook-registration-forbidden'` reaches the relay
 *    client's `send()`.
 * 2. Exactly one `POST /internal/status` with body
 *    `{ status: 'degraded', statusReason: 'webhook-registration-forbidden' }`
 *    reaches the control-plane socket.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { FastifyInstance } from 'fastify';

// Mock executeCommand — return 403 for repo-hook list so the fail-loud path
// fires on first try. All other gh calls (e.g., label sync) return an empty
// success.
vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...original,
    executeCommand: vi.fn(async (_cmd: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('/repos/') && joined.includes('/hooks')) {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'gh: Resource not accessible by integration (HTTP 403)',
        };
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    }),
    createGitHubClient: vi.fn(() => ({
      getIssue: vi.fn(),
      addLabels: vi.fn(),
      removeLabels: vi.fn(),
      listLabels: vi.fn().mockResolvedValue([]),
      listIssuesWithLabel: vi.fn().mockResolvedValue([]),
      createLabel: vi.fn(),
      updateLabel: vi.fn(),
    })),
  };
});

// Mock SmeeWebhookReceiver — no real SSE connections in tests.
vi.mock('../services/smee-receiver.js', () => ({
  SmeeWebhookReceiver: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
  })),
}));

// Spy on the cluster relay client `send()` so we can assert the
// `cluster.bootstrap` webhook-registration-forbidden EventMessage reaches it.
const relaySendSpy = vi.fn();
vi.mock('@generacy-ai/cluster-relay', () => ({
  ClusterRelayClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(() => new Promise<void>(() => {})), // stay pending — mirrors real long-lived reconnect loop
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: relaySendSpy,
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    isConnected: true,
  })),
}));

// Prevent DockerEngineClient construction from throwing (relay-bridge
// integration path needs it to be non-throw so the bridge actually initializes).
vi.mock('@generacy-ai/control-plane', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/control-plane')>();
  return {
    ...original,
    TunnelHandler: vi.fn().mockImplementation(() => ({})),
    getCodeServerManager: vi.fn().mockReturnValue(null),
    DockerEngineClient: vi.fn().mockImplementation(() => ({})),
  };
});

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

describe('#972 server-level: webhook-registration 403 fires the loud-failure triple', () => {
  let baseDir: string;
  let channelFilePath: string;
  let controlSocketPath: string;
  let controlServer: http.Server | null;
  let controlPostBodies: string[];
  let server: FastifyInstance | null;

  beforeEach(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'server-webhook-403-'));
    channelFilePath = join(baseDir, 'smee-channel');
    controlSocketPath = join(baseDir, 'control.sock');
    controlPostBodies = [];
    server = null;
    relaySendSpy.mockClear();

    // Real Unix-domain HTTP server to capture StatusReporter POST /internal/status.
    controlServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/internal/status') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          controlPostBodies.push(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => controlServer!.listen(controlSocketPath, resolve));
    process.env['CONTROL_PLANE_SOCKET_PATH'] = controlSocketPath;
    // Keep the cockpit-answers-writer (#1021) off the non-writable /workspaces
    // default so its init() succeeds in-tree instead of logging an EACCES 503.
    // The writer's init is deferred until after relayClientRef is assigned, so
    // it can no longer reorder the fail-loud path either way — this just keeps
    // the test hermetic and silent.
    process.env['COCKPIT_ANSWERS_FILE'] = join(baseDir, 'cockpit', 'answers.ndjson');
  });

  afterEach(async () => {
    delete process.env['CONTROL_PLANE_SOCKET_PATH'];
    delete process.env['COCKPIT_ANSWERS_FILE'];
    if (server) {
      await server.close();
      server = null;
    }
    if (controlServer) {
      await new Promise<void>((resolve) => controlServer!.close(() => resolve()));
      controlServer = null;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('SC-002: exactly one cluster.bootstrap event + one degraded status transition', async () => {
    const presetSmeeUrl = 'https://smee.io/preset972';
    const config = createTestConfig({
      server: { port: 0, host: '127.0.0.1' },
      redis: { url: 'redis://127.0.0.1:1' },
      auth: {
        enabled: false,
        providers: [],
        jwt: { secret: 'test-secret-at-least-32-characters-long', expiresIn: '1h' },
      },
      logging: { level: 'error', pretty: false },
      labelMonitor: true,
      repositories: [{ owner: 'christrudelpw', repo: 'snappoll' }],
      monitor: {
        pollIntervalMs: 300000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
      },
      prMonitor: { enabled: false },
      smee: {
        channelUrl: presetSmeeUrl,
        channelFilePath,
      },
      webhookSetup: { enabled: true },
      // A non-empty relay apiKey forces initializeRelayBridge() to construct
      // the (mocked) ClusterRelayClient synchronously, so relaySendSpy is
      // reachable by the WebhookSetupService fail-loud triple.
      relay: {
        apiKey: 'test-relay-api-key',
        cloudUrl: 'wss://test.example.com/relay',
      } as unknown as Record<string, unknown>,
    } as Parameters<typeof createTestConfig>[0]);

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Wait for the fire-and-forget ensureWebhooks() to hit the 403, then
    // flush the fail-loud triple's async chain (installationIdProvider
    // resolves → sendRelayEvent + pushStatus fire).
    await vi.waitFor(() => {
      const forbiddenSends = (relaySendSpy.mock.calls as unknown[][]).filter((call) => {
        const msg = call[0] as { event?: string; data?: { reason?: string } };
        return msg?.event === 'cluster.bootstrap'
          && msg?.data?.reason === 'webhook-registration-forbidden';
      });
      expect(forbiddenSends).toHaveLength(1);
    }, { timeout: 20000 });

    await vi.waitFor(() => {
      const degradedPosts = controlPostBodies.filter((body) => {
        try {
          const parsed = JSON.parse(body) as { status?: string; statusReason?: string };
          return parsed.status === 'degraded'
            && parsed.statusReason === 'webhook-registration-forbidden';
        } catch {
          return false;
        }
      });
      expect(degradedPosts).toHaveLength(1);
    }, { timeout: 20000 });

    // Assert — the single relay EventMessage matches the locked shape.
    const forbiddenSends = (relaySendSpy.mock.calls as unknown[][])
      .map((call) => call[0] as { type?: string; event?: string; data?: Record<string, unknown> })
      .filter((msg) => msg?.event === 'cluster.bootstrap'
        && (msg?.data as { reason?: string })?.reason === 'webhook-registration-forbidden');

    expect(forbiddenSends).toHaveLength(1);
    const evt = forbiddenSends[0]!;
    expect(evt.type).toBe('event');
    expect(evt.data).toEqual({
      status: 'failed',
      reason: 'webhook-registration-forbidden',
      repo: 'christrudelpw/snappoll',
      installationId: null,
      missingScope: 'admin:repo_hook',
    });
  }, 60_000);
});
