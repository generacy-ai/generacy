import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshTarget } from '../../../src/cli/commands/deploy/types.js';

vi.mock('../../../src/cli/commands/deploy/ssh-client.js', () => ({
  sshExec: vi.fn(),
}));

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { forwardCredentialsToCluster } from '../../../src/cli/commands/deploy/credential-forward.js';
import { sshExec } from '../../../src/cli/commands/deploy/ssh-client.js';

const mockedSshExec = vi.mocked(sshExec);

function makeTarget(): SshTarget {
  return {
    user: 'deploy',
    host: 'example.com',
    port: 22,
    remotePath: '/home/deploy/generacy',
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as import('pino').Logger;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('forwardCredentialsToCluster', () => {
  const remotePath = '/home/deploy/generacy';

  it('forwards all credentials successfully', () => {
    mockedSshExec.mockReturnValue('');

    const result = forwardCredentialsToCluster(
      makeTarget(),
      remotePath,
      [
        { host: 'ghcr.io', username: 'user1', password: 'pass1' },
        { host: 'registry.example.com', username: 'user2', password: 'pass2' },
      ],
      makeLogger(),
    );

    expect(result.forwarded).toEqual(['ghcr.io', 'registry.example.com']);
    expect(result.failed).toEqual([]);
    expect(mockedSshExec).toHaveBeenCalledTimes(2);
  });

  it('includes correct docker compose exec curl command', () => {
    mockedSshExec.mockReturnValue('');

    forwardCredentialsToCluster(
      makeTarget(),
      remotePath,
      [{ host: 'ghcr.io', username: 'user', password: 'token' }],
      makeLogger(),
    );

    const command = mockedSshExec.mock.calls[0][1];
    expect(command).toContain(`cd "${remotePath}"`);
    expect(command).toContain('docker compose exec -T orchestrator curl');
    expect(command).toContain('--unix-socket /run/generacy-control-plane/control.sock');
    expect(command).toContain('-X PUT');
    expect(command).toContain('/credentials/registry-ghcr.io');
    expect(command).toContain('Content-Type: application/json');
  });

  it('handles partial failure — some succeed, some fail', () => {
    mockedSshExec
      .mockReturnValueOnce('') // first succeeds
      .mockImplementationOnce(() => {
        throw new Error('connection timeout');
      }); // second fails

    const result = forwardCredentialsToCluster(
      makeTarget(),
      remotePath,
      [
        { host: 'ghcr.io', username: 'user1', password: 'pass1' },
        { host: 'registry.example.com', username: 'user2', password: 'pass2' },
      ],
      makeLogger(),
    );

    expect(result.forwarded).toEqual(['ghcr.io']);
    expect(result.failed).toEqual(['registry.example.com']);
  });

  it('handles full failure without throwing', () => {
    mockedSshExec.mockImplementation(() => {
      throw new Error('connection refused');
    });

    const result = forwardCredentialsToCluster(
      makeTarget(),
      remotePath,
      [
        { host: 'ghcr.io', username: 'user1', password: 'pass1' },
        { host: 'registry.example.com', username: 'user2', password: 'pass2' },
      ],
      makeLogger(),
    );

    expect(result.forwarded).toEqual([]);
    expect(result.failed).toEqual(['ghcr.io', 'registry.example.com']);
  });

  it('does not throw even when all credentials fail', () => {
    mockedSshExec.mockImplementation(() => {
      throw new Error('unreachable');
    });

    expect(() =>
      forwardCredentialsToCluster(
        makeTarget(),
        remotePath,
        [{ host: 'ghcr.io', username: 'u', password: 'p' }],
        makeLogger(),
      ),
    ).not.toThrow();
  });

  it('returns empty arrays for empty credentials list', () => {
    const result = forwardCredentialsToCluster(
      makeTarget(),
      remotePath,
      [],
      makeLogger(),
    );

    expect(result.forwarded).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(mockedSshExec).not.toHaveBeenCalled();
  });
});
