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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { downCommand } from '../index.js';
import { runCompose } from '../../cluster/compose.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('downCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls runCompose with ["down"] when --volumes is not passed', async () => {
    await downCommand().parseAsync(['down'], { from: 'user' });

    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['down']);
  });

  it('calls runCompose with ["down", "--volumes"] when --volumes flag is passed', async () => {
    await downCommand().parseAsync(['down', '--volumes'], { from: 'user' });

    expect(runCompose).toHaveBeenCalledWith(mockCtx, ['down', '--volumes']);
  });

  it('throws when runCompose returns ok: false', async () => {
    vi.mocked(runCompose).mockReturnValue({ ok: false, stdout: '', stderr: 'compose error' });

    await expect(
      downCommand().parseAsync(['down'], { from: 'user' }),
    ).rejects.toThrow('Failed to bring down cluster: compose error');
  });
});
