import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Mocks (must be declared before imports that use them)
// ---------------------------------------------------------------------------

// Use the real tmpdir for creating temp directories, then mock homedir
const realTmpdir = os.tmpdir();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp/test-home'),
  };
});

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  readRegistry,
  writeRegistry,
  upsertRegistryEntry,
  removeRegistryEntry,
  RegistryEntrySchema,
  RegistrySchema,
} from '../registry.js';
import type { ClusterContext } from '../context.js';

const mockedHomedir = vi.mocked(os.homedir);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome: string;

function registryDir(): string {
  return path.join(tmpHome, '.generacy');
}

function registryFile(): string {
  return path.join(tmpHome, '.generacy', 'clusters.json');
}

function makeEntry(overrides: Partial<ReturnType<typeof RegistryEntrySchema.parse>> = {}) {
  return {
    clusterId: 'clst_aaa',
    name: 'my-app',
    path: '/projects/my-app',
    composePath: '/projects/my-app/.generacy/docker-compose.yml',
    variant: 'standard' as const,
    channel: 'stable' as const,
    cloudUrl: 'https://api.generacy.ai',
    lastSeen: '2026-01-15T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeMockCtx(overrides: Partial<ClusterContext> = {}): ClusterContext {
  return {
    projectRoot: '/projects/my-app',
    generacyDir: '/projects/my-app/.generacy',
    composePath: '/projects/my-app/.generacy/docker-compose.yml',
    clusterConfig: { channel: 'stable' as const, workers: 1, variant: 'standard' as const },
    clusterIdentity: {
      cluster_id: 'clst_123',
      project_id: 'proj_456',
      org_id: 'org_789',
      cloud_url: 'https://api.generacy.ai',
      activated_at: '2026-01-01T00:00:00.000Z',
    },
    projectName: 'clst_123',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(realTmpdir, 'registry-test-'));
  mockedHomedir.mockReturnValue(tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readRegistry', () => {
  it('returns empty array when file does not exist', () => {
    const result = readRegistry();
    expect(result).toEqual([]);
  });

  it('returns parsed entries from existing file', () => {
    const entries = [makeEntry(), makeEntry({ clusterId: 'clst_bbb', path: '/projects/other' })];
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(entries), 'utf-8');

    const result = readRegistry();
    expect(result).toHaveLength(2);
    expect(result[0].clusterId).toBe('clst_aaa');
    expect(result[1].clusterId).toBe('clst_bbb');
    expect(result[1].path).toBe('/projects/other');
  });
});

describe('writeRegistry', () => {
  it('creates ~/.generacy/ directory if needed', () => {
    expect(fs.existsSync(registryDir())).toBe(false);

    writeRegistry([makeEntry()]);

    expect(fs.existsSync(registryDir())).toBe(true);
    expect(fs.existsSync(registryFile())).toBe(true);
  });

  it('writes valid JSON that round-trips through readRegistry', () => {
    const entries = [makeEntry(), makeEntry({ clusterId: 'clst_bbb', path: '/projects/other' })];

    writeRegistry(entries);

    const raw = fs.readFileSync(registryFile(), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].clusterId).toBe('clst_aaa');
    expect(parsed[1].clusterId).toBe('clst_bbb');

    // Verify round-trip via readRegistry
    const result = readRegistry();
    expect(result).toEqual(entries);
  });
});

describe('upsertRegistryEntry', () => {
  it('adds new entry when not present', () => {
    const ctx = makeMockCtx();

    upsertRegistryEntry(ctx);

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].clusterId).toBe('clst_123');
    expect(registry[0].name).toBe('my-app');
    expect(registry[0].path).toBe('/projects/my-app');
    expect(registry[0].composePath).toBe('/projects/my-app/.generacy/docker-compose.yml');
    expect(registry[0].variant).toBe('standard');
    expect(registry[0].channel).toBe('stable');
    expect(registry[0].cloudUrl).toBe('https://api.generacy.ai');
  });

  it('updates existing entry matched by path, preserving createdAt', () => {
    const originalCreatedAt = '2025-06-01T00:00:00.000Z';
    const existingEntry = makeEntry({
      clusterId: 'clst_old',
      path: '/projects/my-app',
      createdAt: originalCreatedAt,
      lastSeen: '2025-06-01T00:00:00.000Z',
    });
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify([existingEntry]), 'utf-8');

    const ctx = makeMockCtx();
    upsertRegistryEntry(ctx);

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    // Updated fields
    expect(registry[0].clusterId).toBe('clst_123');
    // createdAt should be preserved from the original entry
    expect(registry[0].createdAt).toBe(originalCreatedAt);
    // lastSeen should have been updated (different from original)
    expect(registry[0].lastSeen).not.toBe('2025-06-01T00:00:00.000Z');
  });

  it('sets clusterId to null when clusterIdentity is absent', () => {
    const ctx = makeMockCtx({ clusterIdentity: null });

    upsertRegistryEntry(ctx);

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].clusterId).toBeNull();
    expect(registry[0].cloudUrl).toBeNull();
  });
});

describe('removeRegistryEntry', () => {
  it('removes entry by path', () => {
    const entries = [
      makeEntry({ path: '/projects/app-a', clusterId: 'clst_a' }),
      makeEntry({ path: '/projects/app-b', clusterId: 'clst_b' }),
    ];
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(entries), 'utf-8');

    removeRegistryEntry('/projects/app-a');

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].path).toBe('/projects/app-b');
    expect(registry[0].clusterId).toBe('clst_b');
  });

  it('is a no-op when path not found', () => {
    const entries = [makeEntry({ path: '/projects/app-a' })];
    fs.mkdirSync(registryDir(), { recursive: true });
    fs.writeFileSync(registryFile(), JSON.stringify(entries), 'utf-8');

    removeRegistryEntry('/projects/nonexistent');

    const registry = readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].path).toBe('/projects/app-a');
  });
});
