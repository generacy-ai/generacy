import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ClusterContext } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../cluster/docker.js', () => ({
  ensureDocker: vi.fn(),
}));

const mockCtx: ClusterContext = {
  projectRoot: '',
  generacyDir: '',
  composePath: '',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'cluster-base' },
  clusterIdentity: null,
  projectName: 'test-cluster',
};

vi.mock('../../cluster/context.js', () => ({
  getClusterContext: vi.fn(() => mockCtx),
}));

vi.mock('../../cluster/compose.js', () => ({
  runCompose: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('../../cluster/registry.js', () => ({
  upsertRegistryEntry: vi.fn(),
}));

const mockExecSafe = vi.fn();
vi.mock('../../../utils/exec.js', () => ({
  execSafe: (...args: unknown[]) => mockExecSafe(...args),
  exec: vi.fn(),
  spawnBackground: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runCompose } from '../../cluster/compose.js';
import { updateCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeComposeFile(dir: string, image: string) {
  const composePath = path.join(dir, '.generacy', 'docker-compose.yml');
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, `services:\n  orchestrator:\n    image: ${image}\n`);
  return composePath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateCommand - credential flow', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cred-test-'));
    mockCtx.projectRoot = tmpDir;
    mockCtx.generacyDir = path.join(tmpDir, '.generacy');
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('with-creds-running: materializes scoped config, passes DOCKER_CONFIG, cleans up', async () => {
    const composePath = writeComposeFile(tmpDir, 'ghcr.io/org/cluster-base:stable');
    mockCtx.composePath = composePath;

    // Mock exec into container returning credential
    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: JSON.stringify({ value: JSON.stringify({ username: '_token', password: 'ghp_test' }) }),
      stderr: '',
    });

    await updateCommand().parseAsync(['update'], { from: 'user' });

    // Verify DOCKER_CONFIG was passed to pull
    expect(runCompose).toHaveBeenCalledWith(
      mockCtx,
      ['pull'],
      { env: { DOCKER_CONFIG: path.join(tmpDir, '.generacy', '.docker') } },
    );

    // Verify cleanup happened (no .docker dir left)
    expect(fs.existsSync(path.join(tmpDir, '.generacy', '.docker'))).toBe(false);
  });

  it('without-creds: no credential lookup for Docker Hub images, pull proceeds normally', async () => {
    const composePath = writeComposeFile(tmpDir, 'node:20');
    mockCtx.composePath = composePath;

    await updateCommand().parseAsync(['update'], { from: 'user' });

    // Should NOT have tried to exec into container
    expect(mockExecSafe).not.toHaveBeenCalled();
    // Pull called without env
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['pull'], undefined);
  });

  it('cluster-offline: warning printed, pull proceeds with ambient config', async () => {
    const composePath = writeComposeFile(tmpDir, 'ghcr.io/org/cluster-base:stable');
    mockCtx.composePath = composePath;

    // Mock exec failing (cluster offline)
    mockExecSafe.mockReturnValue({ ok: false, stdout: '', stderr: 'connection refused' });

    await updateCommand().parseAsync(['update'], { from: 'user' });

    // Pull called without env (ambient login)
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['pull'], undefined);
    // No scoped config directory should exist
    expect(fs.existsSync(path.join(tmpDir, '.generacy', '.docker'))).toBe(false);
  });

  it('cleans up scoped config even if pull fails', async () => {
    const composePath = writeComposeFile(tmpDir, 'ghcr.io/org/cluster-base:stable');
    mockCtx.composePath = composePath;

    mockExecSafe.mockReturnValue({
      ok: true,
      stdout: JSON.stringify({ value: JSON.stringify({ username: 'u', password: 'p' }) }),
      stderr: '',
    });

    // Make pull fail
    vi.mocked(runCompose).mockReturnValue({ ok: false, stdout: '', stderr: 'pull failed' });

    await expect(
      updateCommand().parseAsync(['update'], { from: 'user' }),
    ).rejects.toThrow('Failed to pull images');

    // Cleanup still happened
    expect(fs.existsSync(path.join(tmpDir, '.generacy', '.docker'))).toBe(false);
  });
});
