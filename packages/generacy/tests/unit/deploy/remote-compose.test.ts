import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshTarget } from '../../../src/cli/commands/deploy/types.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

vi.mock('../../../src/cli/commands/deploy/ssh-client.js', () => ({
  scpDirectory: vi.fn(),
  sshExec: vi.fn(),
  sshExecWithInput: vi.fn(),
}));

vi.mock('../../../src/cli/commands/deploy/remote-credentials.js', () => ({
  writeRemoteDockerConfig: vi.fn(),
  cleanupRemoteDockerConfig: vi.fn(),
}));

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { deployToRemote } from '../../../src/cli/commands/deploy/remote-compose.js';
import { scpDirectory, sshExec } from '../../../src/cli/commands/deploy/ssh-client.js';

const mockedScpDirectory = vi.mocked(scpDirectory);
const mockedSshExec = vi.mocked(sshExec);

function makeTarget(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    user: 'deploy',
    host: 'example.com',
    port: 22,
    remotePath: '/home/deploy/generacy',
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('deployToRemote', () => {
  const bundleDir = '/tmp/bundle-abc';
  const remotePath = '/home/deploy/generacy';

  it('calls scpDirectory, then sshExec for pull, then sshExec for up', () => {
    const target = makeTarget();

    deployToRemote(target, bundleDir, remotePath);

    expect(mockedScpDirectory).toHaveBeenCalledTimes(1);
    expect(mockedScpDirectory).toHaveBeenCalledWith(target, bundleDir, remotePath);

    expect(mockedSshExec).toHaveBeenCalledTimes(2);
    expect(mockedSshExec).toHaveBeenNthCalledWith(
      1,
      target,
      `cd "${remotePath}" && docker compose pull`,
    );
    expect(mockedSshExec).toHaveBeenNthCalledWith(
      2,
      target,
      `cd "${remotePath}" && docker compose up -d`,
    );
  });

  it('calls scpDirectory before sshExec', () => {
    const callOrder: string[] = [];
    mockedScpDirectory.mockImplementation(() => {
      callOrder.push('scp');
    });
    mockedSshExec.mockImplementation(() => {
      callOrder.push('ssh');
      return '';
    });

    deployToRemote(makeTarget(), bundleDir, remotePath);

    expect(callOrder).toEqual(['scp', 'ssh', 'ssh']);
  });

  it('passes the correct remote path in the cd command', () => {
    const customPath = '/opt/clusters/my-project';
    const target = makeTarget();

    deployToRemote(target, bundleDir, customPath);

    expect(mockedSshExec).toHaveBeenNthCalledWith(
      1,
      target,
      `cd "${customPath}" && docker compose pull`,
    );
    expect(mockedSshExec).toHaveBeenNthCalledWith(
      2,
      target,
      `cd "${customPath}" && docker compose up -d`,
    );
  });

  it('propagates DeployError from scpDirectory directly', () => {
    const scpError = new DeployError('SCP failed: disk full', 'SCP_FAILED');
    mockedScpDirectory.mockImplementationOnce(() => {
      throw scpError;
    });

    expect(() => deployToRemote(makeTarget(), bundleDir, remotePath)).toThrow(scpError);
    // sshExec should never be called if scp fails
    expect(mockedSshExec).not.toHaveBeenCalled();
  });

  it('throws DeployError with PULL_FAILED when docker compose pull fails', () => {
    mockedSshExec.mockImplementationOnce(() => {
      throw new Error('pull network timeout');
    });

    let caught: unknown;
    try {
      deployToRemote(makeTarget(), bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).code).toBe('PULL_FAILED');
  });

  it('throws DeployError with COMPOSE_FAILED when docker compose up fails', () => {
    // First sshExec (pull) succeeds, second (up) fails
    mockedSshExec
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw new Error('compose port conflict');
      });

    let caught: unknown;
    try {
      deployToRemote(makeTarget(), bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).code).toBe('COMPOSE_FAILED');
  });

  it('includes the target hostname in the PULL_FAILED error message', () => {
    const target = makeTarget({ host: 'prod-server.example.com' });
    mockedSshExec.mockImplementationOnce(() => {
      throw new Error('timeout');
    });

    let caught: unknown;
    try {
      deployToRemote(target, bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).message).toContain('prod-server.example.com');
  });

  it('includes the target hostname in the COMPOSE_FAILED error message', () => {
    const target = makeTarget({ host: 'staging.internal' });
    mockedSshExec
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw new Error('port already in use');
      });

    let caught: unknown;
    try {
      deployToRemote(target, bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).message).toContain('staging.internal');
  });

  it('preserves the original error as cause in PULL_FAILED', () => {
    const originalError = new Error('connection reset');
    mockedSshExec.mockImplementationOnce(() => {
      throw originalError;
    });

    let caught: unknown;
    try {
      deployToRemote(makeTarget(), bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).cause).toBe(originalError);
  });

  it('preserves the original error as cause in COMPOSE_FAILED', () => {
    const originalError = new Error('daemon not running');
    mockedSshExec
      .mockImplementationOnce(() => '')
      .mockImplementationOnce(() => {
        throw originalError;
      });

    let caught: unknown;
    try {
      deployToRemote(makeTarget(), bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).cause).toBe(originalError);
  });

  it('handles non-Error throws by converting to string in error message', () => {
    mockedSshExec.mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'raw string error';
    });

    let caught: unknown;
    try {
      deployToRemote(makeTarget(), bundleDir, remotePath);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DeployError);
    expect((caught as DeployError).message).toContain('raw string error');
    expect((caught as DeployError).cause).toBeUndefined();
  });
});
