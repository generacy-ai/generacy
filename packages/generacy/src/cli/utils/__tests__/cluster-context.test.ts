import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/home/testuser'),
}));

vi.mock('../logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { readFileSync } from 'node:fs';
import { getClusterContext } from '../cluster-context.js';

const mockedReadFileSync = vi.mocked(readFileSync);

const VALID_CLUSTER_JSON = JSON.stringify({
  cluster_id: 'test-cluster-123',
  project_id: 'proj_abc',
  org_id: 'org_xyz',
  cloud_url: 'https://api.generacy.ai',
  activated_at: '2026-04-29T00:00:00Z',
});

const VALID_REGISTRY = JSON.stringify({
  version: 1,
  clusters: [
    {
      clusterId: 'test-cluster-123',
      projectId: 'proj_abc',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      path: '/home/testuser/projects/myapp',
      activatedAt: '2026-04-29T00:00:00Z',
      status: 'running',
    },
    {
      clusterId: 'other-cluster',
      projectId: 'proj_def',
      orgId: 'org_xyz',
      cloudUrl: 'https://api.generacy.ai',
      path: '/home/testuser/projects/other',
      activatedAt: '2026-04-28T00:00:00Z',
    },
  ],
});

describe('getClusterContext', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('finds .generacy/cluster.json by walking up from startDir', async () => {
    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p === '/home/testuser/projects/myapp/.generacy/cluster.json') {
        return VALID_CLUSTER_JSON;
      }
      // Registry — return null for missing
      if (p.includes('clusters.json')) throw new Error('ENOENT');
      throw new Error('ENOENT');
    });

    const ctx = await getClusterContext({
      startDir: '/home/testuser/projects/myapp/src/deep/nested',
    });

    expect(ctx.clusterId).toBe('test-cluster-123');
    expect(ctx.projectId).toBe('proj_abc');
    expect(ctx.cloudUrl).toBe('https://api.generacy.ai');
    expect(ctx.projectDir).toBe('/home/testuser/projects/myapp');
    expect(ctx.generacyDir).toBe('/home/testuser/projects/myapp/.generacy');
  });

  it('throws when no .generacy found in any parent', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(
      getClusterContext({ startDir: '/tmp/no-cluster-here' }),
    ).rejects.toThrow('No Generacy cluster found');
  });

  it('throws when cluster.json has invalid JSON', async () => {
    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p.endsWith('cluster.json') && !p.includes('clusters.json')) {
        return 'not valid json{{{';
      }
      throw new Error('ENOENT');
    });

    await expect(
      getClusterContext({ startDir: '/home/testuser/projects/myapp' }),
    ).rejects.toThrow('Cluster configuration is corrupted');
  });

  it('throws when cluster.json fails schema validation', async () => {
    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p.endsWith('cluster.json') && !p.includes('clusters.json')) {
        return JSON.stringify({ cluster_id: '', project_id: 'x', org_id: 'y', cloud_url: 'not-a-url', activated_at: 'bad' });
      }
      throw new Error('ENOENT');
    });

    await expect(
      getClusterContext({ startDir: '/home/testuser/projects/myapp' }),
    ).rejects.toThrow('Cluster configuration is corrupted');
  });

  it('resolves --cluster via registry lookup', async () => {
    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p === '/home/testuser/.generacy/clusters.json') {
        return VALID_REGISTRY;
      }
      throw new Error('ENOENT');
    });

    const ctx = await getClusterContext({ clusterId: 'other-cluster' });

    expect(ctx.clusterId).toBe('other-cluster');
    expect(ctx.projectId).toBe('proj_def');
    expect(ctx.projectDir).toBe('/home/testuser/projects/other');
  });

  it('throws when --cluster ID not found in registry', async () => {
    mockedReadFileSync.mockImplementation((path: any) => {
      const p = String(path);
      if (p === '/home/testuser/.generacy/clusters.json') {
        return VALID_REGISTRY;
      }
      throw new Error('ENOENT');
    });

    await expect(
      getClusterContext({ clusterId: 'nonexistent' }),
    ).rejects.toThrow("Cluster 'nonexistent' not found in registry");
  });

  it('throws when --cluster used but registry missing', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    await expect(
      getClusterContext({ clusterId: 'any-id' }),
    ).rejects.toThrow("not found in registry");
  });
});
