import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findClusterByCwd } from '../find-cluster.js';
import { loadRegistry } from '../registry.js';
import type { ClusterEntry, ClusterRegistry } from '../schema.js';

vi.mock('../registry.js', () => ({
  loadRegistry: vi.fn(),
}));

function makeEntry(overrides: Partial<ClusterEntry> = {}): ClusterEntry {
  return {
    id: 'cluster-1',
    name: 'test-cluster',
    path: '/home/user/projects/my-project',
    cloudUrl: 'https://api.generacy.ai',
    lastSeen: '2026-04-29T10:00:00Z',
    ...overrides,
  };
}

function mockRegistry(clusters: ClusterEntry[]): void {
  const registry: ClusterRegistry = { version: 1, clusters };
  vi.mocked(loadRegistry).mockResolvedValue(registry);
}

describe('findClusterByCwd', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns exact match when cwd equals cluster path', async () => {
    const entry = makeEntry({ path: '/home/user/projects/my-project' });
    mockRegistry([entry]);

    const result = await findClusterByCwd('/home/user/projects/my-project');

    expect(result).toEqual(entry);
  });

  it('returns match when cwd is a subdirectory of cluster path', async () => {
    const entry = makeEntry({ path: '/home/user/projects/my-project' });
    mockRegistry([entry]);

    const result = await findClusterByCwd('/home/user/projects/my-project/src/components');

    expect(result).toEqual(entry);
  });

  it('returns the deepest match when multiple clusters match', async () => {
    const parent = makeEntry({
      id: 'parent',
      name: 'parent-cluster',
      path: '/home/user/projects/my-project',
    });
    const child = makeEntry({
      id: 'child',
      name: 'child-cluster',
      path: '/home/user/projects/my-project/packages/sub',
    });
    mockRegistry([parent, child]);

    const result = await findClusterByCwd(
      '/home/user/projects/my-project/packages/sub/src/index.ts',
    );

    expect(result).toEqual(child);
  });

  it('returns undefined when no cluster matches', async () => {
    const entry = makeEntry({ path: '/home/user/projects/my-project' });
    mockRegistry([entry]);

    const result = await findClusterByCwd('/home/user/other-project');

    expect(result).toBeUndefined();
  });

  it('uses process.cwd() when no cwd argument is provided', async () => {
    const cwdPath = process.cwd();
    const entry = makeEntry({ path: cwdPath });
    mockRegistry([entry]);

    const result = await findClusterByCwd();

    expect(result).toEqual(entry);
  });
});
