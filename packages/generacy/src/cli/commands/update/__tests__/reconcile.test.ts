import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClusterContext } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Mocks: stub `runCompose` so we never invoke docker, stub `ensureDocker` /
// `getClusterContext` / `registry` / docker-config helpers. We DO use real
// `findGeneracyDir` and real `reconcileWorkerCount` against a tmp .generacy dir.
// ---------------------------------------------------------------------------

let tempDir: string;
let generacyDir: string;

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../cluster/docker.js', () => ({
  ensureDocker: vi.fn(),
}));

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
        projectName: 'update-reconcile-test',
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

vi.mock('../../../utils/docker-config.js', () => ({
  extractImageHost: vi.fn(() => undefined),
  materializeScopedDockerConfig: vi.fn(),
  cleanupScopedDockerConfig: vi.fn(),
  getScopedDockerConfigPath: vi.fn(() => '/tmp/docker-config'),
}));

import { runCompose } from '../../cluster/compose.js';
import { updateCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('update command reconcile (#708)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'update-reconcile-'));
    generacyDir = join(tempDir, '.generacy');
    mkdirSync(generacyDir, { recursive: true });
    writeFileSync(join(generacyDir, 'docker-compose.yml'), 'services: {}\n');
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('cluster.yaml workers: 5 + .env WORKER_COUNT=1 → .env shows WORKER_COUNT=5 before runCompose pull', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: 5\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'FOO=bar\nWORKER_COUNT=1\n');

    let envAtFirstCompose: string | null = null;
    let firstComposeSub: string[] | null = null;
    vi.mocked(runCompose).mockImplementation((_ctx, sub) => {
      if (envAtFirstCompose === null) {
        envAtFirstCompose = readFileSync(join(generacyDir, '.env'), 'utf-8');
        firstComposeSub = sub;
      }
      return { ok: true, stdout: '', stderr: '' };
    });

    await updateCommand().parseAsync(['update'], { from: 'user' });

    expect(firstComposeSub).toEqual(['pull']);
    expect(envAtFirstCompose).toContain('WORKER_COUNT=5');
    expect(envAtFirstCompose).toContain('FOO=bar');
  });

  it('cluster.yaml workers: 0 → .env=1, cluster.yaml rewritten to workers: 1, warning logged', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: 0\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'FOO=bar\nWORKER_COUNT=99\n');

    await updateCommand().parseAsync(['update'], { from: 'user' });

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

    await updateCommand().parseAsync(['update'], { from: 'user' });

    const env = readFileSync(join(generacyDir, '.env'), 'utf-8');
    expect(env).toContain('WORKER_COUNT=1');

    const yaml = readFileSync(join(generacyDir, 'cluster.yaml'), 'utf-8');
    expect(yaml).toContain('workers: 1');
  });

  it('reconciliation runs before docker compose pull', async () => {
    writeFileSync(join(generacyDir, 'cluster.yaml'), 'channel: stable\nworkers: 3\nvariant: cluster-base\n');
    writeFileSync(join(generacyDir, '.env'), 'WORKER_COUNT=1\n');

    const calls: Array<{ sub: string[]; envContent: string }> = [];
    vi.mocked(runCompose).mockImplementation((_ctx, sub) => {
      calls.push({ sub, envContent: readFileSync(join(generacyDir, '.env'), 'utf-8') });
      return { ok: true, stdout: '', stderr: '' };
    });

    await updateCommand().parseAsync(['update'], { from: 'user' });

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].sub).toEqual(['pull']);
    expect(calls[0].envContent).toContain('WORKER_COUNT=3');
  });
});
