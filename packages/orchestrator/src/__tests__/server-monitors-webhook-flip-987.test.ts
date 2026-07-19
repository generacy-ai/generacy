/**
 * #987 SC-001 / SC-002 regression gate.
 *
 * Constructs createServer() with the auto-provisioned smee path
 * (config.smee.channelUrl = null, resolver returns a channel URL), fires the
 * captured `onConnected` callback, and asserts all four monitors report
 * `webhooksConfigured=true` at `basePollIntervalMs === fallbackPollIntervalMs`.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

vi.mock('@generacy-ai/workflow-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/workflow-engine')>();
  return {
    ...original,
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

// Capture the receiver's options each time it's constructed. The onConnected
// callback is invoked manually below to simulate the SSE connect event.
type ReceiverOptions = {
  onConnected?: () => void;
  channelUrl: string;
};
const receiverConstructions: ReceiverOptions[] = [];
vi.mock('../services/smee-receiver.js', () => ({
  SmeeWebhookReceiver: vi.fn().mockImplementation((_logger: unknown, _monitor: unknown, options: ReceiverOptions) => {
    receiverConstructions.push(options);
    return { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  }),
}));

// Bypass the async smee channel resolver (returns a URL immediately).
vi.mock('../services/smee-channel-resolver.js', () => ({
  SmeeChannelResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue({
      channelUrl: 'https://smee.io/resolved-987',
      source: 'provisioned',
    }),
  })),
}));

// Suppress webhook setup (not the subject of this test).
vi.mock('../services/webhook-setup-service.js', () => ({
  WebhookSetupService: vi.fn().mockImplementation(() => ({
    ensureWebhooks: vi.fn().mockResolvedValue({ total: 0, created: 0, skipped: 0, reactivated: 0, failed: 0 }),
    findExistingSmeeChannel: vi.fn().mockResolvedValue(null),
  })),
}));

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

describe('#987 SC-001/SC-002: monitors flip to webhook mode on smee receiver connect', () => {
  let baseDir: string;
  let server: FastifyInstance | null;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'server-987-'));
    receiverConstructions.length = 0;
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('fires onConnected → all four monitors report webhooksConfigured=true at fallbackPollIntervalMs', async () => {
    const fallbackPollIntervalMs = 300_000;
    const config = createTestConfig({
      labelMonitor: true,
      repositories: [{ owner: 'test-org', repo: 'test-repo' }],
      monitor: {
        pollIntervalMs: 30_000,
        maxConcurrentPolls: 1,
        adaptivePolling: true,
      },
      prMonitor: {
        enabled: true,
        pollIntervalMs: 60_000,
        adaptivePolling: true,
        maxConcurrentPolls: 3,
      },
      smee: {
        channelFilePath: join(baseDir, 'smee-channel'),
        fallbackPollIntervalMs,
      },
      webhookSetup: { enabled: false },
    } as Parameters<typeof createTestConfig>[0]);

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Wait for the resolver's .then() to fire and construct the receiver.
    await vi.waitFor(() => {
      expect(receiverConstructions.length).toBeGreaterThanOrEqual(1);
    }, { timeout: 5000 });

    const opts = receiverConstructions[0]!;
    expect(opts.channelUrl).toBe('https://smee.io/resolved-987');
    expect(opts.onConnected).toBeInstanceOf(Function);

    // Reach into the server's per-service state via the exported monitor refs.
    // The private hoist path is `server[svcSymbol]?` — we take the pragmatic
    // approach of asserting via the observable side effect: firing onConnected
    // should flip all four monitors' `webhooksConfigured` fields (and align
    // both base+current interval to fallbackPollIntervalMs).
    //
    // We can access the monitor refs from the receiver mock's ctor args
    // (they're captured in options as `*Monitor` fields):
    const optsFull = opts as unknown as Record<string, { getState: () => { webhooksConfigured: boolean; basePollIntervalMs: number; currentPollIntervalMs: number } }>;

    // The SmeeWebhookReceiver mock is invoked as `new Receiver(logger, labelMonitor, opts)`.
    // The label monitor is the second positional arg — reconstruct via the mock's calls.
    const receiverMock = (await import('../services/smee-receiver.js')).SmeeWebhookReceiver as unknown as Mock;
    const [_logger, labelMonitorService] = receiverMock.mock.calls[0]!;
    void _logger;
    const label = labelMonitorService as { getState: () => { webhooksConfigured: boolean; basePollIntervalMs: number; currentPollIntervalMs: number } };
    const prFeedback = optsFull['prFeedbackMonitor']!;
    const mergeConflict = optsFull['mergeConflictMonitor']!;
    const clarification = optsFull['clarificationAnswerMonitor']!;

    // Sanity: before onConnected fires, the initial webhooksConfigured is
    // `config.smee.channelUrl != null` which is `false` here.
    expect(label.getState().webhooksConfigured).toBe(false);
    expect(prFeedback.getState().webhooksConfigured).toBe(false);
    expect(mergeConflict.getState().webhooksConfigured).toBe(false);
    expect(clarification.getState().webhooksConfigured).toBe(false);

    // Fire the onConnected callback (simulates smee SSE connect).
    opts.onConnected!();

    for (const svc of [label, prFeedback, mergeConflict, clarification]) {
      const state = svc.getState();
      expect(state.webhooksConfigured).toBe(true);
      expect(state.basePollIntervalMs).toBe(fallbackPollIntervalMs);
      expect(state.currentPollIntervalMs).toBe(fallbackPollIntervalMs);
    }
  }, 15_000);
});
