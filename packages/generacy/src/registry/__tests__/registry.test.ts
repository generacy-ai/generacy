import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('node:os', () => ({
  homedir: () => '/mock-home',
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import the module under test (after mocks are set up)
// ---------------------------------------------------------------------------

import { loadRegistry, saveRegistry, addCluster, removeCluster } from '../registry.js';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import type { ClusterEntry } from '../schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REGISTRY_PATH = '/mock-home/.generacy/clusters.json';
const REGISTRY_TMP_PATH = '/mock-home/.generacy/clusters.json.tmp';
const REGISTRY_DIR = '/mock-home/.generacy';

function makeEntry(overrides: Partial<ClusterEntry> = {}): ClusterEntry {
  return {
    id: 'cluster-1',
    name: 'Test Cluster',
    path: '/projects/my-app',
    cloudUrl: 'https://api.generacy.ai',
    lastSeen: '2026-04-29T12:00:00Z',
    ...overrides,
  };
}

function makeRegistry(clusters: ClusterEntry[] = []) {
  return { version: 1 as const, clusters };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadRegistry', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
    vi.mocked(rename).mockReset();
    vi.mocked(mkdir).mockReset();
  });

  it('returns empty registry when file does not exist (ENOENT)', async () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    vi.mocked(readFile).mockRejectedValue(error);

    const result = await loadRegistry();

    expect(result).toEqual({ version: 1, clusters: [] });
    expect(readFile).toHaveBeenCalledWith(REGISTRY_PATH, 'utf-8');
  });

  it('returns empty registry when JSON is invalid', async () => {
    vi.mocked(readFile).mockResolvedValue('not valid json {{{');

    const result = await loadRegistry();

    expect(result).toEqual({ version: 1, clusters: [] });
  });

  it('returns empty registry when schema validation fails', async () => {
    // Valid JSON but missing required "version" field
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ clusters: [] }));

    const result = await loadRegistry();

    expect(result).toEqual({ version: 1, clusters: [] });
  });

  it('returns parsed registry when file is valid', async () => {
    const entry = makeEntry();
    const registry = makeRegistry([entry]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(registry));

    const result = await loadRegistry();

    expect(result).toEqual(registry);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].id).toBe('cluster-1');
  });
});

describe('saveRegistry', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(rename).mockReset().mockResolvedValue(undefined);
    vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  });

  it('writes to tmp file then renames (atomic write)', async () => {
    const registry = makeRegistry([makeEntry()]);

    await saveRegistry(registry);

    const expectedContent = JSON.stringify(registry, null, 2) + '\n';
    expect(writeFile).toHaveBeenCalledWith(REGISTRY_TMP_PATH, expectedContent, 'utf-8');
    expect(rename).toHaveBeenCalledWith(REGISTRY_TMP_PATH, REGISTRY_PATH);

    // Verify ordering: writeFile must be called before rename
    const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
    const renameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it('creates directory if needed', async () => {
    const registry = makeRegistry();

    await saveRegistry(registry);

    expect(mkdir).toHaveBeenCalledWith(REGISTRY_DIR, { recursive: true });

    // Verify mkdir is called before writeFile
    const mkdirOrder = vi.mocked(mkdir).mock.invocationCallOrder[0];
    const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
    expect(mkdirOrder).toBeLessThan(writeOrder);
  });
});

describe('addCluster', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(rename).mockReset().mockResolvedValue(undefined);
    vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  });

  it('adds a new cluster entry', async () => {
    // Start with empty registry
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    const entry = makeEntry({ id: 'new-cluster', name: 'New Cluster' });
    await addCluster(entry);

    const expectedRegistry = makeRegistry([entry]);
    const expectedContent = JSON.stringify(expectedRegistry, null, 2) + '\n';
    expect(writeFile).toHaveBeenCalledWith(REGISTRY_TMP_PATH, expectedContent, 'utf-8');
  });

  it('replaces existing cluster with same ID', async () => {
    const existing = makeEntry({ id: 'cluster-1', name: 'Old Name' });
    const registry = makeRegistry([existing]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(registry));

    const updated = makeEntry({ id: 'cluster-1', name: 'Updated Name' });
    await addCluster(updated);

    // The saved registry should contain only the updated entry, not both
    const expectedRegistry = makeRegistry([updated]);
    const expectedContent = JSON.stringify(expectedRegistry, null, 2) + '\n';
    expect(writeFile).toHaveBeenCalledWith(REGISTRY_TMP_PATH, expectedContent, 'utf-8');
  });
});

describe('removeCluster', () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(rename).mockReset().mockResolvedValue(undefined);
    vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  });

  it('removes cluster by ID', async () => {
    const entry1 = makeEntry({ id: 'cluster-1', name: 'Cluster One' });
    const entry2 = makeEntry({ id: 'cluster-2', name: 'Cluster Two' });
    const registry = makeRegistry([entry1, entry2]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(registry));

    await removeCluster('cluster-1');

    const expectedRegistry = makeRegistry([entry2]);
    const expectedContent = JSON.stringify(expectedRegistry, null, 2) + '\n';
    expect(writeFile).toHaveBeenCalledWith(REGISTRY_TMP_PATH, expectedContent, 'utf-8');
  });
});
