/**
 * Tests for RelayBridge.collectMetadata() — codeServerReady field (#586, #596).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => 'origin\tgit@github.com:org/repo.git (fetch)\n'),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{"version":"0.1.0"}'),
  existsSync: vi.fn(() => false),
}));

vi.mock('../../../src/services/code-server-probe.js', () => ({
  probeCodeServerSocket: vi.fn(async () => false),
}));

import { probeCodeServerSocket } from '../../../src/services/code-server-probe.js';
import { RelayBridge } from '../../../src/services/relay-bridge.js';
import type { ClusterRelayClient } from '../../../src/types/relay.js';
import type { SSESubscriptionManager } from '../../../src/sse/subscriptions.js';
import type { FastifyInstance } from 'fastify';

const mockProbe = vi.mocked(probeCodeServerSocket);

function createRelayBridge(): RelayBridge {
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
      clusterYamlPath: '/nonexistent/cluster.yaml',
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
