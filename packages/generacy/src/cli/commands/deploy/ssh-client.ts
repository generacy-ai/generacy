import { execSync } from 'node:child_process';
import { DeployError, type SshTarget } from './types.js';
import { getLogger } from '../../utils/logger.js';

function buildSshArgs(target: SshTarget): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (target.port !== 22) {
    args.push('-p', String(target.port));
  }
  args.push(`${target.user}@${target.host}`);
  return args;
}

function buildScpPortArgs(target: SshTarget): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (target.port !== 22) {
    args.push('-P', String(target.port));
  }
  return args;
}

/**
 * Execute a command on the remote host via SSH.
 */
export function sshExec(target: SshTarget, command: string): string {
  const logger = getLogger();
  const args = [...buildSshArgs(target), command];
  const cmd = ['ssh', ...args].join(' ');
  logger.debug({ cmd }, 'SSH exec');

  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const execErr = error as { stderr?: string | Buffer; message?: string };
    const stderr = typeof execErr.stderr === 'string'
      ? execErr.stderr.trim()
      : (execErr.stderr?.toString() ?? '').trim();
    throw new DeployError(
      `SSH command failed: ${stderr || execErr.message || 'unknown error'}`,
      'SSH_CONNECT_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Execute a command on the remote host via SSH, piping content to stdin.
 * Used for writing file content without shell escaping issues.
 */
export function sshExecWithInput(target: SshTarget, command: string, input: string): string {
  const logger = getLogger();
  const args = [...buildSshArgs(target), command];
  const cmd = ['ssh', ...args].join(' ');
  logger.debug({ cmd }, 'SSH exec with stdin');

  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      input,
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const execErr = error as { stderr?: string | Buffer; message?: string };
    const stderr = typeof execErr.stderr === 'string'
      ? execErr.stderr.trim()
      : (execErr.stderr?.toString() ?? '').trim();
    throw new DeployError(
      `SSH command failed: ${stderr || execErr.message || 'unknown error'}`,
      'SSH_CONNECT_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Verify SSH connectivity to the target host.
 */
export function verifySshConnectivity(target: SshTarget): void {
  sshExec(target, 'echo ok');
}

/**
 * Verify Docker is installed and accessible on the remote host.
 */
export function verifyDockerPresence(target: SshTarget): void {
  try {
    sshExec(target, 'command -v docker');
  } catch {
    throw new DeployError(
      `Docker not found on ${target.host}. Install Docker first:\n` +
      '  curl -fsSL https://get.docker.com | sh',
      'DOCKER_MISSING',
    );
  }
}

/**
 * Copy a local directory to the remote host via SCP.
 */
export function scpDirectory(target: SshTarget, localDir: string, remotePath: string): void {
  const logger = getLogger();

  // Ensure remote directory exists
  sshExec(target, `mkdir -p "${remotePath}"`);

  const portArgs = buildScpPortArgs(target);
  const cmd = ['scp', '-r', ...portArgs, `${localDir}/.`, `${target.user}@${target.host}:${remotePath}/`].join(' ');
  logger.debug({ cmd }, 'SCP directory');

  try {
    execSync(cmd, {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const execErr = error as { stderr?: string | Buffer; message?: string };
    const stderr = typeof execErr.stderr === 'string'
      ? execErr.stderr.trim()
      : (execErr.stderr?.toString() ?? '').trim();
    throw new DeployError(
      `SCP failed: ${stderr || execErr.message || 'unknown error'}`,
      'SCP_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}
