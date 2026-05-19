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

import { ensureDocker } from '../../cluster/docker.js';
import { getClusterContext } from '../../cluster/context.js';
import { runCompose } from '../../cluster/compose.js';
import { stopCommand } from '../index.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stopCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default success return for runCompose
    vi.mocked(runCompose).mockReturnValue({ ok: true, stdout: '', stderr: '' });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('calls ensureDocker, getClusterContext, and runCompose with ["stop"]', async () => {
    await stopCommand().parseAsync(['stop'], { from: 'user' });

    expect(ensureDocker).toHaveBeenCalledOnce();
    expect(getClusterContext).toHaveBeenCalledOnce();
    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['stop']);
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
      stopCommand().parseAsync(['stop'], { from: 'user' }),
    ).rejects.toThrow('Failed to stop cluster: compose error');
  });
});
