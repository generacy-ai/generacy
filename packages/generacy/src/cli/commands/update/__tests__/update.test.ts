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
  upsertRegistryEntry: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { runCompose } from '../../cluster/compose.js';
import { upsertRegistryEntry } from '../../cluster/registry.js';
import { updateCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  it('calls pull then up -d in sequence, calls upsertRegistryEntry', async () => {
    const callOrder: string[] = [];
    vi.mocked(runCompose).mockImplementation((_ctx, sub) => {
      callOrder.push(sub.join(' '));
      return { ok: true, stdout: '', stderr: '' };
    });

    await updateCommand().parseAsync(['update'], { from: 'user' });

    expect(callOrder).toEqual(['pull', 'up -d']);
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['pull']);
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['up', '-d']);
    expect(upsertRegistryEntry).toHaveBeenCalledWith(mockCtx);
  });

  it('throws when pull fails', async () => {
    vi.mocked(runCompose).mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'pull error',
    });

    await expect(
      updateCommand().parseAsync(['update'], { from: 'user' }),
    ).rejects.toThrow('Failed to pull images: pull error');

    // up should NOT have been called -- only one call to runCompose (the pull)
    expect(runCompose).toHaveBeenCalledTimes(1);
  });

  it('throws when up fails', async () => {
    vi.mocked(runCompose)
      .mockReturnValueOnce({ ok: true, stdout: '', stderr: '' }) // pull succeeds
      .mockReturnValueOnce({ ok: false, stdout: '', stderr: 'up error' }); // up fails

    await expect(
      updateCommand().parseAsync(['update'], { from: 'user' }),
    ).rejects.toThrow('Failed to recreate containers: up error');
  });
});
