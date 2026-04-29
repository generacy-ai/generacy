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

import type { ClusterRegistryEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Mock node:os so homedir() returns a per-test temp directory.
// The registry module reads homedir() at module scope to build its paths,
// so we must use vi.resetModules() + dynamic import to re-evaluate the
// module constants after updating the mock return value.
// ---------------------------------------------------------------------------

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, homedir: vi.fn() };
});

// Import the mocked homedir so we can configure its return value per test.
import { homedir } from 'node:os';

const mockedHomedir = vi.mocked(homedir);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const mockEntry: ClusterRegistryEntry = {
  clusterId: 'cluster_abc123',
  name: 'my-project',
  path: '/home/user/Generacy/my-project',
  composePath: '/home/user/Generacy/my-project/.generacy/docker-compose.yml',
  variant: 'standard',
  channel: 'stable',
  cloudUrl: 'https://api.generacy.ai',
  lastSeen: '2026-04-29T12:00:00.000Z',
  createdAt: '2026-04-29T12:00:00.000Z',
};

// ---------------------------------------------------------------------------
// Per-test temp directory & dynamic import helper
// ---------------------------------------------------------------------------

let tempHome: string;

/**
 * Dynamically imports the registry module so that its module-level constants
 * (`REGISTRY_DIR`, `REGISTRY_FILE`, `REGISTRY_TMP`) are evaluated against
 * the current mocked `homedir()` return value.
 */
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
    expect(entries).toEqual([mockEntry]);
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

    const existingEntry: ClusterRegistryEntry = {
      clusterId: 'cluster_existing',
      name: 'existing-project',
      path: '/home/user/Generacy/existing-project',
      composePath: '/home/user/Generacy/existing-project/.generacy/docker-compose.yml',
      variant: 'standard',
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
      JSON.stringify([existingEntry], null, 2),
      'utf-8',
    );

    registerCluster(mockEntry);

    const registryPath = join(generacyDir, 'clusters.json');
    const entries = JSON.parse(readFileSync(registryPath, 'utf-8'));
    expect(entries).toEqual([existingEntry, mockEntry]);
  });

  it('writes via atomic temp file + rename (result file exists, temp file does not)', async () => {
    const { registerCluster } = await importRegistry();

    registerCluster(mockEntry);

    const generacyDir = join(tempHome, '.generacy');
    const registryPath = join(generacyDir, 'clusters.json');
    const tempPath = join(generacyDir, 'clusters.json.tmp');

    // The final file must exist
    expect(existsSync(registryPath)).toBe(true);
    // The temp file must have been renamed away
    expect(existsSync(tempPath)).toBe(false);
  });

  it('writes valid JSON array with correct entry structure', async () => {
    const { registerCluster } = await importRegistry();

    registerCluster(mockEntry);

    const registryPath = join(tempHome, '.generacy', 'clusters.json');
    const raw = readFileSync(registryPath, 'utf-8');

    // Must be parseable JSON
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(raw);
    }).not.toThrow();

    // Must be an array
    expect(Array.isArray(parsed)).toBe(true);

    const entries = parsed as ClusterRegistryEntry[];
    expect(entries).toHaveLength(1);

    // Verify every expected key is present with the correct value
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
});
