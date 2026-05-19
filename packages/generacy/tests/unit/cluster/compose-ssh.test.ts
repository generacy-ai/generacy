import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecResult } from '../../../src/cli/utils/exec.js';
import type { ClusterContext } from '../../../src/cli/commands/cluster/context.js';

// Mock dependencies before imports
vi.mock('../../../src/cli/utils/exec.js', () => ({
  execSafe: vi.fn(() => ({ ok: true, stdout: '', stderr: '' })),
}));

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../../src/cli/commands/cluster/registry.js', () => ({
  readRegistry: vi.fn(() => []),
}));

vi.mock('../../../src/cli/commands/deploy/ssh-client.js', () => ({
  sshExec: vi.fn(() => ''),
}));

vi.mock('../../../src/cli/commands/deploy/ssh-target.js', () => ({
  parseSshTarget: vi.fn((target: string) => ({
    user: 'deploy',
    host: 'example.com',
    port: 22,
    remotePath: '/home/deploy/generacy',
  })),
}));

import { runCompose, dockerComposeArgs } from '../../../src/cli/commands/cluster/compose.js';
import { readRegistry } from '../../../src/cli/commands/cluster/registry.js';
import { sshExec } from '../../../src/cli/commands/deploy/ssh-client.js';
import { parseSshTarget } from '../../../src/cli/commands/deploy/ssh-target.js';
import { execSafe } from '../../../src/cli/utils/exec.js';

function makeCtx(overrides?: Partial<ClusterContext>): ClusterContext {
  return {
    projectRoot: '/home/user/my-project',
    generacyDir: '/home/user/my-project/.generacy',
    composePath: '/home/user/my-project/.generacy/docker-compose.yml',
    clusterConfig: { channel: 'stable', workers: 1, variant: 'standard' },
    clusterIdentity: {
      cluster_id: 'cl-123',
      project_id: 'pj-123',
      org_id: 'org-123',
      cloud_url: 'https://api.generacy.ai',
      activated_at: '2026-01-01T00:00:00.000Z',
    },
    projectName: 'cl-123',
    ...overrides,
  };
}

describe('dockerComposeArgs', () => {
  it('returns project-name and file args', () => {
    const ctx = makeCtx();
    const args = dockerComposeArgs(ctx);
    expect(args).toEqual([
      '--project-name=cl-123',
      '--file=/home/user/my-project/.generacy/docker-compose.yml',
    ]);
  });
});

describe('runCompose', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs locally when no managementEndpoint in registry', () => {
    vi.mocked(readRegistry).mockReturnValue([]);

    const ctx = makeCtx();
    runCompose(ctx, ['up', '-d']);

    expect(execSafe).toHaveBeenCalledWith(
      expect.stringContaining('docker compose'),
    );
    expect(sshExec).not.toHaveBeenCalled();
  });

  it('runs locally when registry entry has no managementEndpoint', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'test',
        path: '/home/user/my-project',
        composePath: '/home/user/my-project/.generacy/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const ctx = makeCtx();
    runCompose(ctx, ['stop']);

    expect(execSafe).toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
  });

  it('forwards docker compose over SSH when managementEndpoint is ssh://', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'test',
        path: '/home/user/my-project',
        composePath: '/home/user/my-project/.generacy/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        managementEndpoint: 'ssh://deploy@example.com/home/deploy/generacy',
      },
    ]);
    vi.mocked(sshExec).mockReturnValue('Services stopped');

    const ctx = makeCtx();
    const result = runCompose(ctx, ['stop']);

    expect(parseSshTarget).toHaveBeenCalledWith('ssh://deploy@example.com/home/deploy/generacy');
    expect(sshExec).toHaveBeenCalledWith(
      { user: 'deploy', host: 'example.com', port: 22, remotePath: '/home/deploy/generacy' },
      expect.stringContaining('docker compose stop'),
    );
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('Services stopped');
    expect(execSafe).not.toHaveBeenCalled();
  });

  it('uses remotePath from parsed target in cd command', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'test',
        path: '/home/user/my-project',
        composePath: '/home/user/my-project/.generacy/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        managementEndpoint: 'ssh://deploy@example.com/home/deploy/generacy',
      },
    ]);
    vi.mocked(sshExec).mockReturnValue('');

    const ctx = makeCtx();
    runCompose(ctx, ['up', '-d']);

    expect(sshExec).toHaveBeenCalledWith(
      expect.anything(),
      'cd "/home/deploy/generacy" && docker compose up -d',
    );
  });

  it('returns ok: false when SSH exec fails', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'test',
        path: '/home/user/my-project',
        composePath: '/home/user/my-project/.generacy/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        managementEndpoint: 'ssh://deploy@example.com/home/deploy/generacy',
      },
    ]);
    vi.mocked(sshExec).mockImplementation(() => {
      throw new Error('Connection refused');
    });

    const ctx = makeCtx();
    const result = runCompose(ctx, ['down']);

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('Connection refused');
  });

  it('matches registry entry by clusterId', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'remote-cluster',
        path: '/remote/path',
        composePath: '/remote/path/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        managementEndpoint: 'ssh://deploy@example.com/remote/path',
      },
    ]);
    vi.mocked(sshExec).mockReturnValue('');

    // ctx path doesn't match registry path, but clusterId does
    const ctx = makeCtx({ projectRoot: '/different/path' });
    runCompose(ctx, ['ps']);

    expect(sshExec).toHaveBeenCalled();
    expect(execSafe).not.toHaveBeenCalled();
  });

  it('falls back to projectRoot when remotePath is null', () => {
    vi.mocked(readRegistry).mockReturnValue([
      {
        clusterId: 'cl-123',
        name: 'test',
        path: '/home/user/my-project',
        composePath: '/home/user/my-project/.generacy/docker-compose.yml',
        variant: 'standard',
        channel: 'stable',
        cloudUrl: 'https://api.generacy.ai',
        lastSeen: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        managementEndpoint: 'ssh://deploy@example.com',
      },
    ]);
    vi.mocked(parseSshTarget).mockReturnValue({
      user: 'deploy',
      host: 'example.com',
      port: 22,
      remotePath: null,
    });
    vi.mocked(sshExec).mockReturnValue('');

    const ctx = makeCtx();
    runCompose(ctx, ['restart']);

    expect(sshExec).toHaveBeenCalledWith(
      expect.anything(),
      `cd "/home/user/my-project" && docker compose restart`,
    );
  });
});
