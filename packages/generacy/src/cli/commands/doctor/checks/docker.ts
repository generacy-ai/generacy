import { execSafe } from '../../../utils/exec.js';
import type { CheckDefinition } from '../types.js';

/**
 * Extract the Docker version string from `docker info` stdout.
 *
 * Looks for a line like "Server Version: 27.0.3" and returns the version,
 * or `null` if not found.
 */
function parseDockerVersion(stdout: string): string | null {
  const match = /Server Version:\s*(.+)/i.exec(stdout);
  return match?.[1]?.trim() ?? null;
}

export const dockerCheck: CheckDefinition = {
  id: 'docker',
  label: 'Docker',
  category: 'system',
  dependencies: [],
  priority: 'P1',

  async run() {
    const result = execSafe('docker info');

    if (!result.ok) {
      const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();

      // Docker binary not found
      if (
        combined.includes('not found') ||
        combined.includes('is not recognized') ||
        combined.includes('no such file')
      ) {
        return {
          status: 'fail',
          message: 'Docker is not installed',
          suggestion: 'Install Docker Desktop from https://docker.com',
          detail: result.stderr || result.stdout,
        };
      }

      // Daemon not running
      if (combined.includes('cannot connect to the docker daemon')) {
        return {
          status: 'fail',
          message: 'Docker daemon is not running',
          suggestion: 'Start Docker Desktop',
          detail: result.stderr || result.stdout,
        };
      }

      // Permission denied
      if (combined.includes('permission denied')) {
        return {
          status: 'fail',
          message: 'Insufficient permissions to access Docker',
          suggestion:
            'Add your user to the docker group: sudo usermod -aG docker $USER (then log out and back in)',
          detail: result.stderr || result.stdout,
        };
      }

      // Unknown failure
      return {
        status: 'fail',
        message: 'Docker check failed',
        suggestion: 'Run `docker info` manually to diagnose the issue',
        detail: result.stderr || result.stdout,
      };
    }

    // Success — extract version
    const version = parseDockerVersion(result.stdout);
    const message = version
      ? `Docker daemon is running (v${version})`
      : 'Docker daemon is running';

    return {
      status: 'pass',
      message,
      detail: version ? `Server Version: ${version}` : undefined,
    };
  },
};
