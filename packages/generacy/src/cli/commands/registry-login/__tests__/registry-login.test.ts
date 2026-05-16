import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  password: vi.fn(),
  isCancel: vi.fn(),
  cancel: vi.fn(),
  outro: vi.fn(),
}));

vi.mock('../../cluster/context.js', () => ({
  getClusterContext: vi.fn(),
}));

vi.mock('../docker-config.js', () => ({
  readDockerConfig: vi.fn(),
  writeDockerConfig: vi.fn(),
  addAuth: vi.fn(),
}));

vi.mock('../credential-forward.js', () => ({
  isClusterRunning: vi.fn(),
  forwardCredential: vi.fn(),
}));

vi.mock('../../../utils/logger.js', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import * as p from '@clack/prompts';
import { getClusterContext } from '../../cluster/context.js';
import { readDockerConfig, writeDockerConfig, addAuth } from '../docker-config.js';
import { isClusterRunning, forwardCredential } from '../credential-forward.js';
import { registryLoginCommand } from '../index.js';

const mockCtx = {
  projectRoot: '/projects/my-app',
  generacyDir: '/projects/my-app/.generacy',
  composePath: '/projects/my-app/.generacy/docker-compose.yml',
  clusterConfig: { channel: 'stable', workers: 1, variant: 'cluster-base' },
  clusterIdentity: null,
  projectName: 'my-app',
};

describe('registry-login command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClusterContext).mockReturnValue(mockCtx as any);
    vi.mocked(readDockerConfig).mockReturnValue({ auths: {} });
    vi.mocked(addAuth).mockReturnValue({ auths: { 'ghcr.io': { auth: 'encoded' } } });
    vi.mocked(p.isCancel).mockReturnValue(false);
  });

  it('prompts for username and password', async () => {
    vi.mocked(p.text).mockResolvedValue('myuser');
    vi.mocked(p.password).mockResolvedValue('mytoken');
    vi.mocked(isClusterRunning).mockReturnValue(false);

    const cmd = registryLoginCommand();
    await cmd.parseAsync(['node', 'registry-login', 'ghcr.io']);

    expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ message: 'Username' }));
    expect(p.password).toHaveBeenCalledWith(expect.objectContaining({ message: 'Token / password' }));
  });

  it('writes scoped Docker config', async () => {
    vi.mocked(p.text).mockResolvedValue('myuser');
    vi.mocked(p.password).mockResolvedValue('mytoken');
    vi.mocked(isClusterRunning).mockReturnValue(false);

    const cmd = registryLoginCommand();
    await cmd.parseAsync(['node', 'registry-login', 'ghcr.io']);

    expect(addAuth).toHaveBeenCalledWith({ auths: {} }, 'ghcr.io', 'myuser', 'mytoken');
    expect(writeDockerConfig).toHaveBeenCalledWith('/projects/my-app/.generacy', { auths: { 'ghcr.io': { auth: 'encoded' } } });
  });

  it('forwards to cluster when running', async () => {
    vi.mocked(p.text).mockResolvedValue('myuser');
    vi.mocked(p.password).mockResolvedValue('mytoken');
    vi.mocked(isClusterRunning).mockReturnValue(true);
    vi.mocked(forwardCredential).mockReturnValue({ ok: true, stdout: '', stderr: '' });

    const cmd = registryLoginCommand();
    await cmd.parseAsync(['node', 'registry-login', 'ghcr.io']);

    expect(forwardCredential).toHaveBeenCalledWith(mockCtx, 'ghcr.io', 'myuser', 'mytoken');
  });

  it('does not forward when cluster not running', async () => {
    vi.mocked(p.text).mockResolvedValue('myuser');
    vi.mocked(p.password).mockResolvedValue('mytoken');
    vi.mocked(isClusterRunning).mockReturnValue(false);

    const cmd = registryLoginCommand();
    await cmd.parseAsync(['node', 'registry-login', 'ghcr.io']);

    expect(forwardCredential).not.toHaveBeenCalled();
  });

  it('exits on cancel during username prompt', async () => {
    vi.mocked(p.text).mockResolvedValue(Symbol('cancel'));
    vi.mocked(p.isCancel).mockReturnValue(true);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

    const cmd = registryLoginCommand();
    await expect(cmd.parseAsync(['registry-login', 'ghcr.io'], { from: 'user' })).rejects.toThrow('exit');

    expect(p.cancel).toHaveBeenCalled();
    mockExit.mockRestore();
  });
});
