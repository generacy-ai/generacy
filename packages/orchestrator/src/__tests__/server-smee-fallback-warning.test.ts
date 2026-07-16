/**
 * Startup wiring test — smee-fallback warning log.
 *
 * Covers #954 as adapted to the #952 smee-resolver model: when no smee
 * channel can be obtained (no `smee.channelUrl`, no persisted channel, and
 * provisioning fails) while the label monitor is active in full mode, the
 * orchestrator must emit a single `warn` describing the polling-fallback
 * state with remediation pointers.
 *
 * Under #952 the "no smee" decision is only known after the async
 * `SmeeChannelResolver` runs on `onReady` — so the warn fires from the
 * resolver's null (webhook-less) branch, not synchronously at construction.
 * These tests mock the resolver to return null to exercise that branch
 * deterministically (the real resolver would attempt to provision a channel
 * over the network).
 *
 * The warn payload contract lives in specs/954-summary-when-no-smee/contracts/log-warning.md.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

// Fake IORedis so worker-mode boot (which throws without Redis) can proceed.
// The mock's `connect()` resolves and events never fire — enough for the
// server to instantiate and reach the label-monitor block (which is skipped
// in worker mode by design).
vi.mock('ioredis', () => {
  class FakeRedis {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url?: string, _opts?: any) {}
    on(_event: string, _fn: (...args: unknown[]) => void) { return this; }
    off(_event: string, _fn: (...args: unknown[]) => void) { return this; }
    once(_event: string, _fn: (...args: unknown[]) => void) { return this; }
    async connect() { return; }
    async quit() { return 'OK' as const; }
    async disconnect() { return; }
    async ping() { return 'PONG' as const; }
    duplicate() { return new FakeRedis(); }
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

vi.mock('../services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

vi.mock('../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => false),
}));

// Force the webhook-less path: the resolver never yields a channel URL, so
// the onReady branch takes the polling-fallback warn. Without this the real
// resolver would try to `POST https://smee.io/new` over the network.
vi.mock('../services/smee-channel-resolver.js', () => ({
  SmeeChannelResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue(null),
  })),
}));

// SmeeWebhookReceiver.start() would open a real EventSource against smee.io
// on the `channelUrl` set path — stub it so those boots stay offline.
vi.mock('../services/smee-receiver.js', () => ({
  SmeeWebhookReceiver: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@generacy-ai/control-plane', async (importOriginal) => {
  const original = await importOriginal<typeof import('@generacy-ai/control-plane')>();
  return {
    ...original,
    getCodeServerManager: vi.fn(() => null),
  };
});

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

import { createServer } from '../server.js';
import { createTestConfig } from '../config/index.js';

interface LogRecord {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

function createCapturingLogger(): { logger: { level: string; stream: Writable }; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const raw = chunk.toString();
      for (const line of raw.split('\n')) {
        if (!line) continue;
        try {
          records.push(JSON.parse(line) as LogRecord);
        } catch {
          // ignore non-JSON lines
        }
      }
      callback();
    },
  });
  return { logger: { level: 'trace', stream }, records };
}

const WARN_LEVEL = 40;
const WARN_MSG = 'No smee channel configured; polling fallback active';

function findWarns(records: LogRecord[]): LogRecord[] {
  return records.filter((r) => r.level === WARN_LEVEL && r.msg === WARN_MSG);
}

/** Let the fire-and-forget onReady resolver `.then()` callback run. */
async function flushResolver(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function buildConfig(overrides: Partial<Parameters<typeof createTestConfig>[0]> = {}) {
  return createTestConfig({
    server: { port: 0, host: '127.0.0.1' },
    redis: { url: 'redis://127.0.0.1:1' },
    auth: {
      enabled: false,
      providers: [],
      jwt: { secret: 'test-secret-at-least-32-characters-long', expiresIn: '1h' },
    },
    logging: { level: 'trace', pretty: false },
    ...overrides,
  });
}

describe('server startup: smee-fallback warning', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('emits exactly one warn with the contract payload when no channel resolves (full+labelMonitor+repositories)', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: true,
      repositories: [{ owner: 'org', repo: 'repo' }],
      monitor: {
        pollIntervalMs: 300000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
      },
      smee: {}, // channelUrl undefined → resolver runs, mocked to null
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await vi.waitFor(() => {
      expect(findWarns(records)).toHaveLength(1);
    });

    const warn = findWarns(records)[0]!;

    expect(warn['pollIntervalMs']).toBe(300000);
    expect(warn['completedCheckInterval']).toBe(3);
    expect(warn['processLatencyMs']).toBe(300000);
    expect(warn['completedLatencyMs']).toBe(900000);
    expect(warn['remediation']).toEqual([
      'SMEE_CHANNEL_URL',
      'orchestrator.smeeChannelUrl',
    ]);

    const serialized = JSON.stringify(warn);
    expect(serialized).toContain('smee');
    expect(serialized).toContain('polling');
    expect(serialized).toContain('SMEE_CHANNEL_URL');
    expect(serialized).toContain('orchestrator.smeeChannelUrl');
    expect(serialized).toContain('pollIntervalMs');
    expect(serialized).toContain('completedCheckInterval');
    expect(serialized).toContain('processLatencyMs');
    expect(serialized).toContain('completedLatencyMs');
  });

  it('numeric invariant: completedLatencyMs === pollIntervalMs * completedCheckInterval AND completedCheckInterval === 3', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: true,
      repositories: [{ owner: 'org', repo: 'repo' }],
      monitor: {
        pollIntervalMs: 45000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
      },
      smee: {},
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await vi.waitFor(() => {
      expect(findWarns(records)).toHaveLength(1);
    });

    const warn = findWarns(records)[0]!;

    expect(warn['completedCheckInterval']).toBe(3);
    expect(warn['completedLatencyMs']).toBe(
      (warn['pollIntervalMs'] as number) * (warn['completedCheckInterval'] as number),
    );
  });

  it('computed-not-hardcoded: non-default pollIntervalMs=60000 → processLatencyMs=60000, completedLatencyMs=180000', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: true,
      repositories: [{ owner: 'org', repo: 'repo' }],
      monitor: {
        pollIntervalMs: 60000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
      },
      smee: {},
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await vi.waitFor(() => {
      expect(findWarns(records)).toHaveLength(1);
    });

    const warn = findWarns(records)[0]!;

    expect(warn['pollIntervalMs']).toBe(60000);
    expect(warn['processLatencyMs']).toBe(60000);
    expect(warn['completedLatencyMs']).toBe(180000);
  });

  it('negative: does NOT warn when smee.channelUrl is set (static pipeline, no resolver)', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: true,
      repositories: [{ owner: 'org', repo: 'repo' }],
      monitor: {
        pollIntervalMs: 300000,
        maxConcurrentPolls: 1,
        adaptivePolling: false,
        webhookSecret: 'a-secret',
      },
      smee: { channelUrl: 'https://smee.io/abc' },
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await flushResolver();

    expect(findWarns(records)).toHaveLength(0);
  });

  it('negative: worker mode with smee.channelUrl unset → no warn', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'worker',
      labelMonitor: true,
      repositories: [{ owner: 'org', repo: 'repo' }],
      smee: {},
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await flushResolver();

    expect(findWarns(records)).toHaveLength(0);
  });

  it('negative: pre-activation cluster (repositories=[]) → no warn', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: true,
      repositories: [],
      smee: {},
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await flushResolver();

    expect(findWarns(records)).toHaveLength(0);
  });

  it('negative: labelMonitor disabled → no warn', async () => {
    const { logger, records } = createCapturingLogger();

    const config = buildConfig({
      mode: 'full',
      labelMonitor: false,
      repositories: [{ owner: 'org', repo: 'repo' }],
      smee: {},
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();
    await flushResolver();

    expect(findWarns(records)).toHaveLength(0);
  });
});
