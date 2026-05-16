import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshTarget } from '../../../src/cli/commands/deploy/types.js';

vi.mock('../../../src/cli/commands/deploy/ssh-client.js', () => ({
  sshExec: vi.fn(),
  sshExecWithInput: vi.fn(),
}));

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { buildDockerConfigJson, writeRemoteDockerConfig, cleanupRemoteDockerConfig } from '../../../src/cli/commands/deploy/remote-credentials.js';
import { sshExec, sshExecWithInput } from '../../../src/cli/commands/deploy/ssh-client.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

const mockedSshExec = vi.mocked(sshExec);
const mockedSshExecWithInput = vi.mocked(sshExecWithInput);

function makeTarget(): SshTarget {
  return {
    user: 'deploy',
    host: 'example.com',
    port: 22,
    remotePath: '/home/deploy/generacy',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('buildDockerConfigJson', () => {
  it('builds config for a single registry', () => {
    const result = buildDockerConfigJson([
      { host: 'ghcr.io', username: 'user', password: 'token123' },
    ]);
    const parsed = JSON.parse(result);

    expect(parsed.auths).toBeDefined();
    expect(parsed.auths['ghcr.io']).toBeDefined();
    expect(parsed.auths['ghcr.io'].auth).toBe(
      Buffer.from('user:token123').toString('base64'),
    );
  });

  it('builds config for multiple registries', () => {
    const result = buildDockerConfigJson([
      { host: 'ghcr.io', username: 'user1', password: 'pass1' },
      { host: 'registry.example.com', username: 'user2', password: 'pass2' },
    ]);
    const parsed = JSON.parse(result);

    expect(Object.keys(parsed.auths)).toHaveLength(2);
    expect(parsed.auths['ghcr.io'].auth).toBe(
      Buffer.from('user1:pass1').toString('base64'),
    );
    expect(parsed.auths['registry.example.com'].auth).toBe(
      Buffer.from('user2:pass2').toString('base64'),
    );
  });

  it('returns valid JSON', () => {
    const result = buildDockerConfigJson([
      { host: 'ghcr.io', username: 'user', password: 'p@ss:word!' },
    ]);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});

describe('writeRemoteDockerConfig', () => {
  it('calls sshExecWithInput with correct command and stdin content', () => {
    const target = makeTarget();
    const remotePath = '/home/deploy/generacy';
    const credentials = [
      { host: 'ghcr.io', username: 'user', password: 'token' },
    ];

    writeRemoteDockerConfig(target, remotePath, credentials);

    expect(mockedSshExecWithInput).toHaveBeenCalledTimes(1);
    const [callTarget, command, input] = mockedSshExecWithInput.mock.calls[0];
    expect(callTarget).toBe(target);
    expect(command).toContain('mkdir -p');
    expect(command).toContain(`${remotePath}/.docker`);
    expect(command).toContain('config.json');
    expect(command).toContain('chmod 600');

    // Verify stdin content is valid Docker config
    const parsed = JSON.parse(input);
    expect(parsed.auths['ghcr.io'].auth).toBe(
      Buffer.from('user:token').toString('base64'),
    );
  });

  it('throws DeployError with CREDENTIAL_WRITE_FAILED on SSH failure', () => {
    mockedSshExecWithInput.mockImplementationOnce(() => {
      throw new Error('permission denied');
    });

    expect(() =>
      writeRemoteDockerConfig(makeTarget(), '/path', [
        { host: 'ghcr.io', username: 'u', password: 'p' },
      ]),
    ).toThrow(DeployError);

    try {
      writeRemoteDockerConfig(makeTarget(), '/path', [
        { host: 'ghcr.io', username: 'u', password: 'p' },
      ]);
    } catch (e) {
      expect((e as DeployError).code).toBe('CREDENTIAL_WRITE_FAILED');
    }
  });
});

describe('cleanupRemoteDockerConfig', () => {
  it('calls sshExec with rm -f command', () => {
    const target = makeTarget();
    const remotePath = '/home/deploy/generacy';

    cleanupRemoteDockerConfig(target, remotePath);

    expect(mockedSshExec).toHaveBeenCalledTimes(1);
    const [callTarget, command] = mockedSshExec.mock.calls[0];
    expect(callTarget).toBe(target);
    expect(command).toContain('rm -f');
    expect(command).toContain(`${remotePath}/.docker/config.json`);
    expect(command).toContain('rmdir');
  });

  it('does not throw when SSH fails (best-effort cleanup)', () => {
    mockedSshExec.mockImplementationOnce(() => {
      throw new Error('connection lost');
    });

    expect(() =>
      cleanupRemoteDockerConfig(makeTarget(), '/path'),
    ).not.toThrow();
  });
});
