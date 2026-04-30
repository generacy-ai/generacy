import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SshTarget } from '../../../src/cli/commands/deploy/types.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

import { execSync } from 'node:child_process';
import { sshExec, verifySshConnectivity, verifyDockerPresence, scpDirectory } from '../../../src/cli/commands/deploy/ssh-client.js';

const mockedExecSync = vi.mocked(execSync);

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
  vi.clearAllMocks();
});

describe('sshExec', () => {
  it('includes BatchMode=yes and StrictHostKeyChecking=accept-new in SSH args', () => {
    mockedExecSync.mockReturnValue('output\n');
    const target = makeTarget();

    sshExec(target, 'whoami');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('-o BatchMode=yes');
    expect(cmd).toContain('-o StrictHostKeyChecking=accept-new');
  });

  it('adds -p <port> flag when port is not 22', () => {
    mockedExecSync.mockReturnValue('output\n');
    const target = makeTarget({ port: 2222 });

    sshExec(target, 'whoami');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('-p 2222');
  });

  it('does not add -p flag when port is 22', () => {
    mockedExecSync.mockReturnValue('output\n');
    const target = makeTarget({ port: 22 });

    sshExec(target, 'whoami');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).not.toMatch(/-p \d+/);
  });

  it('returns trimmed stdout from execSync', () => {
    mockedExecSync.mockReturnValue('  hello world  \n');
    const result = sshExec(makeTarget(), 'echo hello');
    expect(result).toBe('hello world');
  });

  it('throws DeployError with SSH_CONNECT_FAILED on execSync failure', () => {
    const err = new Error('command failed');
    (err as any).stderr = '';
    mockedExecSync.mockImplementation(() => { throw err; });

    expect(() => sshExec(makeTarget(), 'whoami')).toThrow(DeployError);
    try {
      sshExec(makeTarget(), 'whoami');
    } catch (e) {
      expect(e).toBeInstanceOf(DeployError);
      expect((e as DeployError).code).toBe('SSH_CONNECT_FAILED');
    }
  });

  it('includes stderr content in error message', () => {
    const err = new Error('command failed');
    (err as any).stderr = 'Permission denied (publickey)';
    mockedExecSync.mockImplementation(() => { throw err; });

    expect(() => sshExec(makeTarget(), 'whoami')).toThrow(
      /Permission denied \(publickey\)/,
    );
  });

  it('handles stderr as Buffer', () => {
    const err = new Error('command failed');
    (err as any).stderr = Buffer.from('Connection refused');
    mockedExecSync.mockImplementation(() => { throw err; });

    expect(() => sshExec(makeTarget(), 'whoami')).toThrow(/Connection refused/);
  });

  it('includes user@host in the command', () => {
    mockedExecSync.mockReturnValue('ok\n');
    sshExec(makeTarget({ user: 'admin', host: '10.0.0.1' }), 'ls');

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('admin@10.0.0.1');
  });
});

describe('verifySshConnectivity', () => {
  it('calls execSync with ssh ... echo ok', () => {
    mockedExecSync.mockReturnValue('ok\n');
    verifySshConnectivity(makeTarget());

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toMatch(/^ssh\s/);
    expect(cmd).toContain('echo ok');
  });
});

describe('verifyDockerPresence', () => {
  it('calls execSync with ssh ... command -v docker', () => {
    mockedExecSync.mockReturnValue('/usr/bin/docker\n');
    verifyDockerPresence(makeTarget());

    const cmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(cmd).toContain('command -v docker');
  });

  it('throws DeployError with DOCKER_MISSING when docker is not found', () => {
    mockedExecSync.mockImplementation(() => {
      const err = new Error('command failed');
      (err as any).stderr = 'not found';
      throw err;
    });

    expect(() => verifyDockerPresence(makeTarget())).toThrow(DeployError);
    try {
      verifyDockerPresence(makeTarget());
    } catch (e) {
      expect(e).toBeInstanceOf(DeployError);
      expect((e as DeployError).code).toBe('DOCKER_MISSING');
      expect((e as DeployError).message).toContain('Docker not found');
    }
  });
});

describe('scpDirectory', () => {
  it('creates remote directory first, then runs scp with -r flag', () => {
    mockedExecSync.mockReturnValue('');
    const target = makeTarget();

    scpDirectory(target, '/tmp/bundle', '/home/deploy/generacy');

    // First call: mkdir via ssh
    expect(mockedExecSync).toHaveBeenCalledTimes(2);
    const mkdirCmd = mockedExecSync.mock.calls[0]![0] as string;
    expect(mkdirCmd).toMatch(/^ssh\s/);
    expect(mkdirCmd).toContain('mkdir -p');
    expect(mkdirCmd).toContain('/home/deploy/generacy');

    // Second call: scp -r
    const scpCmd = mockedExecSync.mock.calls[1]![0] as string;
    expect(scpCmd).toMatch(/^scp\s/);
    expect(scpCmd).toContain('-r');
    expect(scpCmd).toContain('/tmp/bundle/.');
    expect(scpCmd).toContain('deploy@example.com:/home/deploy/generacy/');
  });

  it('uses uppercase -P for SCP port flag when port is not 22', () => {
    mockedExecSync.mockReturnValue('');
    const target = makeTarget({ port: 2222 });

    scpDirectory(target, '/tmp/bundle', '/home/deploy/generacy');

    // The scp command is the second call (first is mkdir via ssh)
    const scpCmd = mockedExecSync.mock.calls[1]![0] as string;
    expect(scpCmd).toContain('-P 2222');
    // Ensure it does not use lowercase -p for scp
    expect(scpCmd).not.toMatch(/\s-p\s+2222/);
  });

  it('includes BatchMode=yes and StrictHostKeyChecking=accept-new in SCP args', () => {
    mockedExecSync.mockReturnValue('');
    scpDirectory(makeTarget(), '/tmp/bundle', '/remote/path');

    const scpCmd = mockedExecSync.mock.calls[1]![0] as string;
    expect(scpCmd).toContain('-o BatchMode=yes');
    expect(scpCmd).toContain('-o StrictHostKeyChecking=accept-new');
  });

  it('throws DeployError with SCP_FAILED on scp failure', () => {
    // First call (mkdir) succeeds, second call (scp) fails
    let callCount = 0;
    mockedExecSync.mockImplementation(() => {
      callCount++;
      if (callCount >= 2) {
        const err = new Error('scp failed');
        (err as any).stderr = 'No space left on device';
        throw err;
      }
      return '';
    });

    expect(() => scpDirectory(makeTarget(), '/tmp/bundle', '/remote/path')).toThrow(DeployError);

    callCount = 0;
    try {
      scpDirectory(makeTarget(), '/tmp/bundle', '/remote/path');
    } catch (e) {
      expect(e).toBeInstanceOf(DeployError);
      expect((e as DeployError).code).toBe('SCP_FAILED');
      expect((e as DeployError).message).toContain('No space left on device');
    }
  });
});
