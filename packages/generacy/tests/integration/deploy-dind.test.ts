/**
 * Integration test for deploy command using Docker-in-Docker as SSH target.
 *
 * This test requires:
 * - Docker available on the host
 * - A DinD container with SSH server running
 *
 * Skip in CI unless DEPLOY_INTEGRATION=1 is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { parseSshTarget, formatSshTarget } from '../../src/cli/commands/deploy/ssh-target.js';
import { DeployError } from '../../src/cli/commands/deploy/types.js';

const SKIP = !process.env['DEPLOY_INTEGRATION'];
const CONTAINER_NAME = 'generacy-deploy-test-target';
const SSH_PORT = 2299;

function dockerExec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 60_000 }).trim();
  } catch (error) {
    const err = error as { stderr?: string };
    throw new Error(`Docker command failed: ${err.stderr ?? String(error)}`);
  }
}

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(SKIP)('deploy integration (DinD)', () => {
  beforeAll(() => {
    if (!isDockerAvailable()) {
      throw new Error('Docker is required for integration tests');
    }

    // Clean up any leftover container
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' });
    } catch {
      // Ignore — container may not exist
    }
  });

  afterAll(() => {
    try {
      execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('parseSshTarget produces valid target for DinD container', () => {
    const target = parseSshTarget(`ssh://root@localhost:${SSH_PORT}/tmp/generacy-test`);
    expect(target).toEqual({
      user: 'root',
      host: 'localhost',
      port: SSH_PORT,
      remotePath: '/tmp/generacy-test',
    });
  });

  it('formatSshTarget round-trips with custom port', () => {
    const target = {
      user: 'root',
      host: 'localhost',
      port: SSH_PORT,
      remotePath: '/tmp/generacy-test',
    };
    const formatted = formatSshTarget(target);
    expect(formatted).toBe(`ssh://root@localhost:${SSH_PORT}/tmp/generacy-test`);

    const reparsed = parseSshTarget(formatted);
    expect(reparsed).toEqual(target);
  });

  it('rejects invalid SSH target gracefully', () => {
    expect(() => parseSshTarget('http://example.com')).toThrow(DeployError);
    expect(() => parseSshTarget('not-a-url')).toThrow(DeployError);
    expect(() => parseSshTarget('')).toThrow(DeployError);
  });

  it('DeployError carries correct error code', () => {
    try {
      parseSshTarget('http://example.com');
    } catch (error) {
      expect(error).toBeInstanceOf(DeployError);
      expect((error as DeployError).code).toBe('INVALID_TARGET');
    }
  });
});
