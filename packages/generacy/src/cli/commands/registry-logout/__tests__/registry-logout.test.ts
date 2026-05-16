import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@clack/prompts', () => ({
  outro: vi.fn(),
}));

vi.mock('../../cluster/context.js', () => ({
  getClusterContext: vi.fn(),
}));

vi.mock('../../registry-login/docker-config.js', () => ({
  readDockerConfig: vi.fn(),
  writeDockerConfig: vi.fn(),
  removeAuth: vi.fn(),
}));

vi.mock('../../registry-login/credential-forward.js', () => ({
  isClusterRunning: vi.fn(),
  removeCredential: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { getClusterContext } from '../../cluster/context.js';
import { readDockerConfig, writeDockerConfig, removeAuth } from '../../registry-login/docker-config.js';
import { isClusterRunning, removeCredential } from '../../registry-login/credential-forward.js';
import { registryLogoutCommand } from '../index.js';

const mockCtx = {
  projectRoot: '/projects/my-app',
  generacyDir: '/projects/my-app/.generacy',
  composePath: '/projects/my-app/.generacy/docker-compose.yml',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'cluster-base' },
  clusterIdentity: null,
  projectName: 'my-app',
};

describe('registry-logout command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClusterContext).mockReturnValue(mockCtx as any);
    vi.mocked(readDockerConfig).mockReturnValue({ auths: { 'ghcr.io': { auth: 'encoded' } } });
    vi.mocked(removeAuth).mockReturnValue({ auths: {} });
  });

  it('removes from scoped Docker config', async () => {
    vi.mocked(isClusterRunning).mockReturnValue(false);

    const cmd = registryLogoutCommand();
    await cmd.parseAsync(['node', 'registry-logout', 'ghcr.io']);

    expect(removeAuth).toHaveBeenCalledWith({ auths: { 'ghcr.io': { auth: 'encoded' } } }, 'ghcr.io');
    expect(writeDockerConfig).toHaveBeenCalledWith('/projects/my-app/.generacy', { auths: {} });
  });

  it('removes from control-plane when cluster running', async () => {
    vi.mocked(isClusterRunning).mockReturnValue(true);
    vi.mocked(removeCredential).mockReturnValue({ ok: true, stdout: '', stderr: '' });

    const cmd = registryLogoutCommand();
    await cmd.parseAsync(['node', 'registry-logout', 'ghcr.io']);

    expect(removeCredential).toHaveBeenCalledWith(mockCtx, 'ghcr.io');
  });

  it('does not call removeCredential when cluster not running', async () => {
    vi.mocked(isClusterRunning).mockReturnValue(false);

    const cmd = registryLogoutCommand();
    await cmd.parseAsync(['node', 'registry-logout', 'ghcr.io']);

    expect(removeCredential).not.toHaveBeenCalled();
  });

  it('handles removeCredential failure gracefully', async () => {
    vi.mocked(isClusterRunning).mockReturnValue(true);
    vi.mocked(removeCredential).mockReturnValue({ ok: false, stdout: '', stderr: 'not found' });

    const cmd = registryLogoutCommand();
    // Should not throw
    await cmd.parseAsync(['node', 'registry-logout', 'ghcr.io']);

    expect(removeCredential).toHaveBeenCalled();
  });
});
