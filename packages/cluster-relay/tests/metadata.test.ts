import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayConfig } from '../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { collectMetadata } from '../src/metadata.js';

const baseConfig: RelayConfig = {
  apiKey: 'test-key',
  orchestratorUrl: 'http://localhost:3000',
  relayUrl: 'wss://api.generacy.ai/relay',
  requestTimeoutMs: 30000,
  heartbeatIntervalMs: 30000,
  baseReconnectDelayMs: 5000,
  maxReconnectDelayMs: 300000,
};

function createMockFetch(options?: {
  healthThrows?: boolean;
  metricsThrows?: boolean;
}) {
  return vi.fn(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url.toString();

    if (urlStr.endsWith('/health')) {
      if (options?.healthThrows) {
        throw new Error('Health endpoint unreachable');
      }
      return new Response(
        JSON.stringify({
          version: '1.0.0',
          channel: 'stable',
          uptime: 7200,
          codeServerReady: true,
          controlPlaneReady: true,
        }),
        { status: 200 },
      );
    }

    if (urlStr.endsWith('/metrics')) {
      if (options?.metricsThrows) {
        throw new Error('Metrics endpoint unreachable');
      }
      return new Response(
        JSON.stringify({ workerCount: 4, activeWorkflows: 2 }),
        { status: 200 },
      );
    }

    return new Response('Not found', { status: 404 });
  });
}

describe('collectMetadata', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'origin\tgit@github.com:org/repo.git (fetch)\norigin\tgit@github.com:org/repo.git (push)\n',
    );
  });

  it('returns full ClusterMetadata on successful collection', async () => {
    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);

    expect(metadata).toEqual({
      workerCount: 4,
      activeWorkflows: 2,
      channel: 'stable',
      orchestratorVersion: '1.0.0',
      gitRemotes: [{ name: 'origin', url: 'git@github.com:org/repo.git' }],
      uptime: 7200,
      codeServerReady: true,
      controlPlaneReady: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/metrics',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns default health values when /health endpoint fails', async () => {
    const mockFetch = createMockFetch({ healthThrows: true });
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);

    expect(metadata.orchestratorVersion).toBe('0.0.0');
    expect(metadata.channel).toBe('stable');
    expect(metadata.uptime).toBe(0);

    // Metrics should still succeed
    expect(metadata.workerCount).toBe(4);
    expect(metadata.activeWorkflows).toBe(2);
  });

  it('returns default metrics values when /metrics endpoint fails', async () => {
    const mockFetch = createMockFetch({ metricsThrows: true });
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);

    expect(metadata.workerCount).toBe(0);
    expect(metadata.activeWorkflows).toBe(0);

    // Health should still succeed
    expect(metadata.orchestratorVersion).toBe('1.0.0');
    expect(metadata.channel).toBe('stable');
    expect(metadata.uptime).toBe(7200);
  });

  it('returns all default values when both endpoints fail', async () => {
    const mockFetch = createMockFetch({
      healthThrows: true,
      metricsThrows: true,
    });
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);

    expect(metadata).toEqual({
      workerCount: 0,
      activeWorkflows: 0,
      channel: 'stable',
      orchestratorVersion: '0.0.0',
      gitRemotes: [{ name: 'origin', url: 'git@github.com:org/repo.git' }],
      uptime: 0,
      codeServerReady: false,
      controlPlaneReady: false,
    });
  });

  it('includes codeServerReady from /health response', async () => {
    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);
    expect(metadata.codeServerReady).toBe(true);
  });

  it('defaults codeServerReady to false when field missing from /health', async () => {
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr.endsWith('/health')) {
        return new Response(
          JSON.stringify({ version: '1.0.0', channel: 'stable', uptime: 100 }),
          { status: 200 },
        );
      }
      if (urlStr.endsWith('/metrics')) {
        return new Response(
          JSON.stringify({ workerCount: 1, activeWorkflows: 0 }),
          { status: 200 },
        );
      }
      return new Response('Not found', { status: 404 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);
    expect(metadata.codeServerReady).toBe(false);
  });

  it('defaults codeServerReady to false when /health fails', async () => {
    const mockFetch = createMockFetch({ healthThrows: true });
    vi.stubGlobal('fetch', mockFetch);

    const metadata = await collectMetadata(baseConfig);
    expect(metadata.codeServerReady).toBe(false);
  });

  it('parses git remotes correctly from git remote -v output', async () => {
    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);

    (execSync as ReturnType<typeof vi.fn>).mockReturnValue(
      'origin\tgit@github.com:org/repo.git (fetch)\n' +
      'origin\tgit@github.com:org/repo.git (push)\n' +
      'upstream\thttps://github.com/upstream/repo.git (fetch)\n' +
      'upstream\thttps://github.com/upstream/repo.git (push)\n',
    );

    const metadata = await collectMetadata(baseConfig);

    expect(metadata.gitRemotes).toEqual([
      { name: 'origin', url: 'git@github.com:org/repo.git' },
      { name: 'upstream', url: 'https://github.com/upstream/repo.git' },
    ]);

    expect(execSync).toHaveBeenCalledWith('git remote -v', {
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('returns empty gitRemotes when execSync throws', async () => {
    const mockFetch = createMockFetch();
    vi.stubGlobal('fetch', mockFetch);

    (execSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('git not found');
    });

    const metadata = await collectMetadata(baseConfig);

    expect(metadata.gitRemotes).toEqual([]);
    // Other fields should still be populated
    expect(metadata.orchestratorVersion).toBe('1.0.0');
    expect(metadata.workerCount).toBe(4);
  });
});
