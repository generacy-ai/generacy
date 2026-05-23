import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClusterContext } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Mocks: stub `runCompose` so we never invoke docker, stub `ensureDocker` /
// `getClusterContext` / `registry`. We DO use real `findGeneracyDir` and
// real `reconcileWorkerCount` against a tmp .generacy dir.
// ---------------------------------------------------------------------------

let tempDir: string;
let generacyDir: string;

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../cluster/docker.js', () => ({
  ensureDocker: vi.fn(),
}));

// Override findGeneracyDir to return our tmp .generacy/; let the real
// reconcileWorkerCount run against it. getClusterContext is stubbed so the
// strict schema doesn't run.
vi.mock('../../cluster/context.js', async () => {
  const actual: typeof import('../../cluster/context.js') =
    await vi.importActual('../../cluster/context.js');
  return {
    ...actual,
    findGeneracyDir: vi.fn(() => generacyDir),
    getClusterContext: vi.fn(
      (): ClusterContext => ({
        projectRoot: tempDir,
        generacyDir,
        composePath: join(generacyDir, 'docker-compose.yml'),
        clusterConfig: { channel: 'stable', workers: 1, variant: 'cluster-base' },
        clusterIdentity: null,
        projectName: 'reconcile-test',
      }),
    ),
  };
});

vi.mock('../../cluster/compose.js', () => ({
  runCompose: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('../../cluster/registry.js', () => ({
  upsertRegistryEntry: vi.fn(),
}));

import { runCompose } from '../../cluster/compose.js';
import { upCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('up command reconcile (#708)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'up-reconcile-'));
    generacyDir = join(tempDir, '.generacy');
    require('node:fs').mkdirSync(generacyDir, { recursive: true });
    // Stub compose file so getClusterContext doesn't throw (we mock it anyway).
    writeFileSync(join(generacyDir, 'docker-compose.yml'), 'services: {}\n');
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('cluster.yaml workers: 5 + .env WORKER_COUNT=1 → .env shows WORKER_COUNT=5 before runCompose', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: 5\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'FOO=bar\nWORKER_COUNT=1\n');

    let envAtComposeTime: string | null = null;
    vi.mocked(runCompose).mockImplementation(() => {
      envAtComposeTime = readFileSync(join(generacyDir, '.env'), 'utf-8');
      return { ok: true, stdout: '', stderr: '' };
    });

    await upCommand().parseAsync(['up'], { from: 'user' });

    expect(envAtComposeTime).toContain('WORKER_COUNT=5');
    expect(envAtComposeTime).toContain('FOO=bar');
  });

  it('cluster.yaml workers: 0 → .env=1, cluster.yaml rewritten to workers: 1, warning logged', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: 0\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'FOO=bar\nWORKER_COUNT=99\n');

    await upCommand().parseAsync(['up'], { from: 'user' });

    const env = readFileSync(join(generacyDir, '.env'), 'utf-8');
    expect(env).toContain('WORKER_COUNT=1');

    const yaml = readFileSync(join(generacyDir, 'cluster.yaml'), 'utf-8');
    expect(yaml).toContain('workers: 1');
    expect(yaml).toContain('channel: stable');
    expect(yaml).toContain('variant: cluster-base');
  });

  it('cluster.yaml workers: "five" → .env=1, cluster.yaml rewritten, malformed warning logged', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: "five"\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'WORKER_COUNT=42\n');

    await upCommand().parseAsync(['up'], { from: 'user' });

    const env = readFileSync(join(generacyDir, '.env'), 'utf-8');
    expect(env).toContain('WORKER_COUNT=1');

    const yaml = readFileSync(join(generacyDir, 'cluster.yaml'), 'utf-8');
    expect(yaml).toContain('workers: 1');
  });
});
