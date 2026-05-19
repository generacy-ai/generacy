import { userInfo } from 'node:os';
import { DeployError, type SshTarget } from './types.js';

/**
 * Parse an SSH target URL: ssh://[user@]host[:port][/path]
 */
export function parseSshTarget(target: string): SshTarget {
  if (!target.startsWith('ssh://')) {
    throw new DeployError(
      `Invalid target "${target}". Expected ssh://[user@]host[:port][/path]`,
      'INVALID_TARGET',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new DeployError(
      `Invalid SSH URL "${target}". Expected ssh://[user@]host[:port][/path]`,
      'INVALID_TARGET',
    );
  }

  if (parsed.protocol !== 'ssh:') {
    throw new DeployError(
      `Unsupported scheme "${parsed.protocol}". Only ssh:// is supported.`,
      'INVALID_TARGET',
    );
  }

  const host = parsed.hostname;
  if (!host) {
    throw new DeployError(
      `Missing hostname in "${target}"`,
      'INVALID_TARGET',
    );
  }

  const user = parsed.username || userInfo().username;
  const port = parsed.port ? parseInt(parsed.port, 10) : 22;

  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw new DeployError(
      `Invalid port ${parsed.port} in "${target}". Must be 1-65535.`,
      'INVALID_TARGET',
    );
  }

  const rawPath = parsed.pathname;
  const remotePath = rawPath && rawPath !== '/' ? decodeURIComponent(rawPath) : null;

  return { user, host, port, remotePath };
}

/**
 * Format an SshTarget back into a URL string.
 */
export function formatSshTarget(target: SshTarget): string {
  const portPart = target.port !== 22 ? `:${target.port}` : '';
  const pathPart = target.remotePath ?? '';
  return `ssh://${target.user}@${target.host}${portPart}${pathPart}`;
}
