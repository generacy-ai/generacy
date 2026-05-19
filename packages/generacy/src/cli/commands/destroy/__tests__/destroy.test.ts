import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  projectRoot: '/projects/my-app',
  generacyDir: '/projects/my-app/.generacy',
  composePath: '/projects/my-app/.generacy/docker-compose.yml',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'standard' },
  clusterIdentity: null,
  projectName: 'my-app',
};

vi.mock('../../cluster/context.js', () => ({
  getClusterContext: vi.fn(() => mockCtx),
}));

vi.mock('../../cluster/compose.js', () => ({
  runCompose: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('../../cluster/registry.js', () => ({
  removeRegistryEntry: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  log: { info: vi.fn() },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { destroyCommand } from '../index.js';
import { runCompose } from '../../cluster/compose.js';
import { removeRegistryEntry } from '../../cluster/registry.js';
import * as p from '@clack/prompts';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('destroyCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // --yes flag: skip prompt
  // -------------------------------------------------------------------------

  it('with --yes: skips prompt, calls runCompose, removes dir, removes registry entry', async () => {
    await destroyCommand().parseAsync(['destroy', '--yes'], { from: 'user' });

    expect(p.confirm).not.toHaveBeenCalled();
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['down', '-v']);
    expect(fs.rmSync).toHaveBeenCalledWith('/projects/my-app/.generacy', {
      recursive: true,
      force: true,
    });
    expect(removeRegistryEntry).toHaveBeenCalledWith('/projects/my-app');
  });

  // -------------------------------------------------------------------------
  // No --yes, user confirms
  // -------------------------------------------------------------------------

  it('without --yes + user confirms: prompts then proceeds with destroy', async () => {
    vi.mocked(p.confirm).mockResolvedValue(true);
    vi.mocked(p.isCancel).mockReturnValue(false);

    await destroyCommand().parseAsync(['destroy'], { from: 'user' });

    expect(p.confirm).toHaveBeenCalled();
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['down', '-v']);
    expect(fs.rmSync).toHaveBeenCalledWith('/projects/my-app/.generacy', {
      recursive: true,
      force: true,
    });
    expect(removeRegistryEntry).toHaveBeenCalledWith('/projects/my-app');
  });

  // -------------------------------------------------------------------------
  // No --yes, user cancels
  // -------------------------------------------------------------------------

  it('without --yes + user cancels: does NOT call runCompose or rm', async () => {
    vi.mocked(p.confirm).mockResolvedValue(false);
    vi.mocked(p.isCancel).mockReturnValue(false);

    await destroyCommand().parseAsync(['destroy'], { from: 'user' });

    expect(p.confirm).toHaveBeenCalled();
    expect(runCompose).not.toHaveBeenCalled();
    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(removeRegistryEntry).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // runCompose failure
  // -------------------------------------------------------------------------

  it('throws when runCompose returns ok: false', async () => {
    vi.mocked(runCompose).mockReturnValue({ ok: false, stdout: '', stderr: 'compose error' });

    await expect(
      destroyCommand().parseAsync(['destroy', '--yes'], { from: 'user' }),
    ).rejects.toThrow('Failed to destroy cluster: compose error');

    expect(fs.rmSync).not.toHaveBeenCalled();
    expect(removeRegistryEntry).not.toHaveBeenCalled();
  });
});
