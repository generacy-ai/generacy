/**
 * Startup wiring test — webhook-setup opt-out info log.
 *
 * Covers #954: When smee.channelUrl IS set but webhookSetup.enabled is
 * false, the orchestrator must emit a single `info` log making the
 * deliberate opt-out visible (rather than silence).
 *
 * The info line fires from an onReady hook in full mode. When smee is
 * unset, the T007 warn covers the case instead — this info must NOT
 * duplicate it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';

vi.mock('../services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

vi.mock('../services/control-plane-probe.js', () => ({
  probeControlPlaneSocket: vi.fn(async () => false),
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

// SmeeWebhookReceiver.start() would try to open a real EventSource against
// smee.io — mock it out so the onReady hook completes cleanly.
vi.mock('../services/smee-webhook-receiver.js', () => ({
  SmeeWebhookReceiver: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

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

const INFO_LEVEL = 30;
const INFO_MSG =
  'Webhook auto-setup disabled; no GitHub webhooks will be created for monitored repos';

function findInfos(records: LogRecord[]): LogRecord[] {
  return records.filter((r) => r.level === INFO_LEVEL && r.msg === INFO_MSG);
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

describe('server startup: webhook auto-setup opt-out info', () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('emits exactly one info when smee.channelUrl is set and webhookSetup.enabled is false', async () => {
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
      webhookSetup: { enabled: false },
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();

    const infos = findInfos(records);
    expect(infos).toHaveLength(1);
    expect(infos[0]!['remediation']).toEqual([
      'GENERACY_WEBHOOK_SETUP_ENABLED',
      'orchestrator.webhookSetup.enabled',
    ]);
  });

  it('negative: does NOT emit the info when webhookSetup.enabled is true', async () => {
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
      webhookSetup: { enabled: true },
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();

    expect(findInfos(records)).toHaveLength(0);
  });

  it('negative: does NOT emit the info when smee.channelUrl is unset (T007 warn covers that case)', async () => {
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
      smee: {},
      webhookSetup: { enabled: false },
      prMonitor: { enabled: false },
    });

    server = await createServer({ config, fastifyOptions: { logger } });
    await server.ready();

    expect(findInfos(records)).toHaveLength(0);
  });
});
