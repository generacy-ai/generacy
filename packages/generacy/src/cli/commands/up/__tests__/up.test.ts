import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClusterContext } from '../../cluster/context.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../../utils/logger.js', () => ({
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

import { ensureDocker } from '../../cluster/docker.js';
import { getClusterContext } from '../../cluster/context.js';
import { runCompose } from '../../cluster/compose.js';
import { upsertRegistryEntry } from '../../cluster/registry.js';
import { upCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('upCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default success return for runCompose
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('calls ensureDocker, getClusterContext, runCompose with ["up", "-d"], and upsertRegistryEntry', async () => {
    await upCommand().parseAsync(['up'], { from: 'user' });

    expect(ensureDocker).toHaveBeenCalledOnce();
    expect(getClusterContext).toHaveBeenCalledOnce();
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['up', '-d']);
    expect(upsertRegistryEntry).toHaveBeenCalledWith(mockCtx);
  });

  // -------------------------------------------------------------------------
  // Failure: compose returns ok: false
  // -------------------------------------------------------------------------

  it('throws when runCompose returns ok: false', async () => {
    vi.mocked(runCompose).mockReturnValue({
      ok: false,
      stdout: '',
      stderr: 'compose error',
    });

    await expect(
      upCommand().parseAsync(['up'], { from: 'user' }),
    ).rejects.toThrow('Failed to start cluster: compose error');
  });
});
