/**
 * Integration test for #952: auto-provision smee.io channel on orchestrator startup.
 *
 * Covers I1–I6 from contracts/server-pipeline.md §"Test contract":
 *   I1  sync path: config.smee.channelUrl set → receiver constructed, resolver NOT invoked
 *   I2  async path succeeds: unset URL → resolver runs, provisions, wires receiver
 *   I3  worker-mode skip: resolver never invoked
 *   I4  wizard-mode skip: repositories=[] → resolver never invoked
 *   I5  fire-and-forget invariant: server.listen() returns fast even when fetch hangs
 *   I6  persisted file reuse across simulated restarts: second server hits tier 2, no fetch
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// Mock the workflow-engine before importing the server.
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

// Mock SmeeWebhookReceiver — no real SSE connections in tests. We track construction
// arguments to verify the pipeline wires the resolved URL through.
const smeeReceiverCtor = vi.fn();
const smeeReceiverStart = vi.fn().mockResolvedValue(undefined);
const smeeReceiverStop = vi.fn();

vi.mock('../services/smee-receiver.js', () => ({
  SmeeWebhookReceiver: vi.fn().mockImplementation((...args: unknown[]) => {
    smeeReceiverCtor(...args);
    return {
      start: smeeReceiverStart,
      stop: smeeReceiverStop,
    };
  }),
}));

// Mock WebhookSetupService — track ensureWebhooks calls.
const ensureWebhooksMock = vi.fn().mockResolvedValue({ total: 0, created: 0, skipped: 0, reactivated: 0, failed: 0 });
vi.mock('../services/webhook-setup-service.js', () => ({
  WebhookSetupService: vi.fn().mockImplementation(() => ({
    ensureWebhooks: ensureWebhooksMock,
  })),
}));

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

const TEST_OWNER = 'test-org';
const TEST_REPO = 'test-repo';

interface Fetch302Options {
  location?: string | null;
  status?: number;
}

function make302Response({ location = 'https://smee.io/testProvisioned', status = 302 }: Fetch302Options = {}): Response {
  const headers = new Headers();
  if (location !== null) {
    headers.set('location', location);
  }
  return new Response(null, { status, headers });
}

describe('#952: server smee provisioning', () => {
  let baseDir: string;
  let channelFilePath: string;
  let server: FastifyInstance | null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'server-smee-'));
    channelFilePath = join(baseDir, 'smee-channel');
    server = null;
    smeeReceiverCtor.mockClear();
    smeeReceiverStart.mockClear();
    smeeReceiverStop.mockClear();
    ensureWebhooksMock.mockClear();
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (server) {
      await server.close();
      server = null;
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  function buildConfig(overrides: Record<string, unknown> = {}) {
    return createTestConfig({
      server: { port: 0, host: '127.0.0.1' },
      redis: { url: 'redis://127.0.0.1:1' },
      auth: {
        enabled: false,
        providers: [],
        jwt: { secret: 'test-secret-at-least-32-characters-long', expiresIn: '1h' },
      },
      logging: { level: 'error', pretty: false },
      labelMonitor: true,
      repositories: [{ owner: TEST_OWNER, repo: TEST_REPO }],
      monitor: {
        pollIntervalMs: 300000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
      },
      prMonitor: { enabled: false },
      smee: { channelFilePath },
      webhookSetup: { enabled: true },
      ...overrides,
    } as Parameters<typeof createTestConfig>[0]);
  }

  it('I1: sync path — config.smee.channelUrl set → receiver constructed, resolver NOT invoked', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const presetUrl = 'https://smee.io/preset123';
    const config = buildConfig({
      smee: { channelUrl: presetUrl, channelFilePath },
    });

    server = await createServer({ config });
    await server.ready();

    // Receiver constructed synchronously with the preset URL, before onReady.
    expect(smeeReceiverCtor).toHaveBeenCalledTimes(1);
    const ctorCall = smeeReceiverCtor.mock.calls[0] as unknown[];
    // args: (logger, labelMonitorService, options)
    const receiverOptions = ctorCall[2] as { channelUrl: string };
    expect(receiverOptions.channelUrl).toBe(presetUrl);

    // Resolver did NOT run.
    expect(fetchMock).not.toHaveBeenCalled();
    // Persisted file was NOT touched.
    expect(existsSync(channelFilePath)).toBe(false);

    // Ensure webhook setup was called with the preset URL.
    expect(ensureWebhooksMock).toHaveBeenCalledWith(presetUrl, expect.any(Array));
  }, 15_000);

  it('I2: async path succeeds — resolver runs, receiver wired, file persisted with mode 0600', async () => {
    const provisionedUrl = 'https://smee.io/newProvisionedXYZ';
    const fetchMock = vi.fn().mockResolvedValue(make302Response({ location: provisionedUrl }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const config = buildConfig();

    server = await createServer({ config });
    await server.listen({ port: 0, host: '127.0.0.1' });

    // Wait for resolver's .then() to fire and construct the receiver.
    await vi.waitFor(() => {
      expect(smeeReceiverCtor).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    const ctorCall = smeeReceiverCtor.mock.calls[0] as unknown[];
    const receiverOptions = ctorCall[2] as { channelUrl: string };
    expect(receiverOptions.channelUrl).toBe(provisionedUrl);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://smee.io/new', expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
    }));

    // File persisted with correct mode + content
    expect(existsSync(channelFilePath)).toBe(true);
    expect(readFileSync(channelFilePath, 'utf-8')).toBe(provisionedUrl);
    expect(statSync(channelFilePath).mode & 0o777).toBe(0o600);

    // ensureWebhooks called with provisioned URL
    await vi.waitFor(() => {
      expect(ensureWebhooksMock).toHaveBeenCalledWith(provisionedUrl, expect.any(Array));
    }, { timeout: 5000 });
  }, 15_000);

  it('I4: wizard-mode skip — empty repositories → resolver never invoked, no file created', async () => {
    const fetchMock = vi.fn().mockResolvedValue(make302Response());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const config = buildConfig({ repositories: [] });

    server = await createServer({ config });
    await server.ready();

    // Small tick to let any stray async task try to run.
    await new Promise((r) => setTimeout(r, 100));

    expect(smeeReceiverCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(channelFilePath)).toBe(false);
  }, 15_000);

  it('I5: fire-and-forget invariant — hanging fetch does not block server.listen()', async () => {
    // fetch returns a promise that never resolves — resolver's tier 3 would hang
    // if the pipeline were awaiting it. server.listen() must return anyway.
    const hangingFetch = vi.fn().mockImplementation(() => new Promise(() => {}));
    globalThis.fetch = hangingFetch as unknown as typeof globalThis.fetch;

    const config = buildConfig();

    server = await createServer({ config });

    const start = Date.now();
    await server.listen({ port: 0, host: '127.0.0.1' });
    const elapsed = Date.now() - start;

    // server.listen must return promptly — well under the 5s resolver timeout budget.
    expect(elapsed).toBeLessThan(2000);

    // smeeReceiver stays null because the resolver hasn't resolved yet.
    expect(smeeReceiverCtor).not.toHaveBeenCalled();
  }, 15_000);

  it('I6: persisted-file reuse across simulated restarts — tier 2 hit, zero fetch calls', async () => {
    const provisionedUrl = 'https://smee.io/first-boot-provisioned';

    // First boot: provision via network
    const firstFetch = vi.fn().mockResolvedValue(make302Response({ location: provisionedUrl }));
    globalThis.fetch = firstFetch as unknown as typeof globalThis.fetch;

    const firstConfig = buildConfig();
    server = await createServer({ config: firstConfig });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(smeeReceiverCtor).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    await server.close();
    server = null;

    // Sanity: file is present with the URL
    expect(readFileSync(channelFilePath, 'utf-8')).toBe(provisionedUrl);
    smeeReceiverCtor.mockClear();

    // Second boot: fetch must NOT be called; tier 2 reads the file
    const secondFetch = vi.fn();
    globalThis.fetch = secondFetch as unknown as typeof globalThis.fetch;

    const secondConfig = buildConfig();
    server = await createServer({ config: secondConfig });
    await server.listen({ port: 0, host: '127.0.0.1' });

    await vi.waitFor(() => {
      expect(smeeReceiverCtor).toHaveBeenCalledTimes(1);
    }, { timeout: 5000 });

    expect(secondFetch).not.toHaveBeenCalled();

    const ctorCall = smeeReceiverCtor.mock.calls[0] as unknown[];
    const receiverOptions = ctorCall[2] as { channelUrl: string };
    expect(receiverOptions.channelUrl).toBe(provisionedUrl);
  }, 20_000);

  it('I3: worker-mode skip — resolver never invoked in worker mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(make302Response());
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    // Worker mode is controlled by `config.mode === 'worker'` (server.ts:169).
    // Worker mode requires Redis (server.ts:266-270); with an unreachable Redis
    // URL, createServer() throws before ever reaching label-monitor / smee wiring.
    // That the throw happens BEFORE any smee code path proves the resolver is not
    // reachable in worker mode. If a future refactor moves smee wiring above the
    // Redis check, this test's expectations still hold: the resolver must not fire.
    const config = buildConfig({ mode: 'worker' });

    await expect(createServer({ config })).rejects.toThrow(/worker mode/);

    // Small tick to let any stray async task try to run.
    await new Promise((r) => setTimeout(r, 100));

    expect(smeeReceiverCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(channelFilePath)).toBe(false);
  }, 15_000);
});
