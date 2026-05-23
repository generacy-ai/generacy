/**
 * Tests for RelayBridge.collectMetadata() — codeServerReady field (#586, #596).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'origin\tgit@github.com:org/repo.git (fetch)\n'),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => '{"version":"0.1.0"}'),
  };
});

vi.mock('../../../src/services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

import { probeCodeServerSocket } from '../../../src/services/code-server-probe.js';
import { RelayBridge } from '../../../src/services/relay-bridge.js';
import type { ClusterRelayClient } from '../../../src/types/relay.js';
import type { SSESubscriptionManager } from '../../../src/sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';

const mockProbe = vi.mocked(probeCodeServerSocket);

function createRelayBridge(clusterYamlPath = '/nonexistent/cluster.yaml'): RelayBridge {
  const fakeClient = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: false,
  } as unknown as ClusterRelayClient;

  const fakeServer = {} as FastifyInstance;
  const fakeSseManager = {
    broadcast: vi.fn(),
  } as unknown as SSESubscriptionManager;

  return new RelayBridge({
    client: fakeClient,
    server: fakeServer,
    sseManager: fakeSseManager,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    config: {
      metadataIntervalMs: 60000,
      clusterYamlPath,
    } as any,
  });
}

describe('RelayBridge.collectMetadata — codeServerReady', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes codeServerReady: false when probe returns false', async () => {
    mockProbe.mockResolvedValue(false);
    const bridge = createRelayBridge();
    const metadata = await bridge.collectMetadata();

    expect(metadata.codeServerReady).toBe(false);
  });

  it('includes codeServerReady: true when probe returns true', async () => {
    mockProbe.mockResolvedValue(true);
    const bridge = createRelayBridge();
    const metadata = await bridge.collectMetadata();

    expect(metadata.codeServerReady).toBe(true);
  });

  it('collectMetadata returns a promise', () => {
    const bridge = createRelayBridge();
    const result = bridge.collectMetadata();
    expect(result).toBeInstanceOf(Promise);
  });
});

describe('RelayBridge.collectMetadata — cluster.yaml + cluster.local.yaml merge (#709)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'relay-bridge-metadata-test-'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads workers and channel from cluster.yaml when no local file exists', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\nworkers: 2\n',
    );

    const bridge = createRelayBridge(join(tempDir, 'cluster.yaml'));
    const metadata = await bridge.collectMetadata();

    expect(metadata.workers).toBe(2);
    expect(metadata.channel).toBe('stable');
  });

  it('cluster.local.yaml workers overrides cluster.yaml workers in metadata', async () => {
    writeFileSync(
      join(tempDir, 'cluster.yaml'),
      'channel: stable\nworkers: 1\n',
    );
    writeFileSync(join(tempDir, 'cluster.local.yaml'), 'workers: 7\n');

    const bridge = createRelayBridge(join(tempDir, 'cluster.yaml'));
    const metadata = await bridge.collectMetadata();

    expect(metadata.workers).toBe(7);
    expect(metadata.channel).toBe('stable');
  });

  it('omits workers/channel when neither file exists', async () => {
    const bridge = createRelayBridge(join(tempDir, 'cluster.yaml'));
    const metadata = await bridge.collectMetadata();

    expect(metadata.workers).toBeUndefined();
    expect(metadata.channel).toBeUndefined();
  });
});
