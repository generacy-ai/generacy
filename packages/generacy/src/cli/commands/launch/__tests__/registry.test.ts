import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryEntry } from '../../cluster/registry.js';

// ---------------------------------------------------------------------------
// Mock node:os so homedir() returns a per-test temp directory.
// ---------------------------------------------------------------------------

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn() };
});

import { homedir } from 'node:os';

const mockedHomedir = vi.mocked(homedir);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const mockEntry: RegistryEntry = {
  clusterId: 'cluster_abc123',
  name: 'my-project',
  path: '/home/user/Generacy/my-project',
  composePath: '/home/user/Generacy/my-project/.generacy/docker-compose.yml',
  variant: 'cluster-base',
  channel: 'stable',
  cloudUrl: 'https://api.generacy.ai',
  lastSeen: '2026-04-29T12:00:00.000Z',
  createdAt: '2026-04-29T12:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Per-test temp directory & dynamic import helper
// ---------------------------------------------------------------------------

let tempHome: string;

async function importRegistry() {
  const mod = await import('../registry.js');
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  tempHome = mkdtempSync(join(tmpdir(), 'registry-test-'));
  mockedHomedir.mockReturnValue(tempHome);
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerCluster', () => {
  it('creates new registry file when ~/.generacy/clusters.json does not exist', async () => {
    const { registerCluster } = await importRegistry();

    registerCluster(mockEntry);

    const registryPath = join(tempHome, '.generacy', 'clusters.json');
    expect(existsSync(registryPath)).toBe(true);

    const entries = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(entries).toHaveLength(1);
    expect(entries[0].clusterId).toBe('cluster_abc123');
  });

  it('creates .generacy directory if it does not exist', async () => {
    const { registerCluster } = await importRegistry();

    const generacyDir = join(tempHome, '.generacy');
    expect(existsSync(generacyDir)).toBe(false);

    registerCluster(mockEntry);

    expect(existsSync(generacyDir)).toBe(true);
  });

  it('appends to existing registry file', async () => {
    const { registerCluster } = await importRegistry();

    const existingEntry: RegistryEntry = {
      clusterId: 'cluster_existing',
      name: 'existing-project',
      path: '/home/user/Generacy/existing-project',
      composePath: '/home/user/Generacy/existing-project/.generacy/docker-compose.yml',
      variant: 'cluster-base',
      channel: 'stable',
      cloudUrl: 'https://api.generacy.ai',
      lastSeen: '2026-04-28T10:00:00.000Z',
      createdAt: '2026-04-28T10:00:00.000Z',
    };

    // Pre-populate the registry file
    const generacyDir = join(tempHome, '.generacy');
    mkdirSync(generacyDir, { recursive: true });
    writeFileSync(
      join(generacyDir, 'clusters.json'),
      JSON.stringify([existingEntry], null, 2) + '\n',
      'utf-8',
    );

    registerCluster(mockEntry);

    const registryPath = join(generacyDir, 'clusters.json');
    const entries = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(entries).toHaveLength(2);
    expect(entries[0].clusterId).toBe('cluster_existing');
    expect(entries[1].clusterId).toBe('cluster_abc123');
  });

  it('writes valid JSON array with correct entry structure', async () => {
    const { registerCluster } = await importRegistry();

    registerCluster(mockEntry);

    const registryPath = join(tempHome, '.generacy', 'clusters.json');
    const raw = readFileSync(registryPath, 'utf-8');

    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();

    expect(Array.isArray(parsed)).toBe(true);

    const entries = parsed as RegistryEntry[];
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.clusterId).toBe(mockEntry.clusterId);
    expect(entry.name).toBe(mockEntry.name);
    expect(entry.path).toBe(mockEntry.path);
    expect(entry.composePath).toBe(mockEntry.composePath);
    expect(entry.variant).toBe(mockEntry.variant);
    expect(entry.channel).toBe(mockEntry.channel);
    expect(entry.cloudUrl).toBe(mockEntry.cloudUrl);
    expect(entry.lastSeen).toBe(mockEntry.lastSeen);
    expect(entry.createdAt).toBe(mockEntry.createdAt);
  });

  it('rejects entries with invalid variant enum', async () => {
    const { registerCluster } = await importRegistry();

    const badEntry = { ...mockEntry, variant: 'standard' } as any;
    expect(() => registerCluster(badEntry)).toThrow();
  });
});
