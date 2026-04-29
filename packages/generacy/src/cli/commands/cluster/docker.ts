import { execSafe } from '../../utils/exec.js';

export function ensureDocker(): void {
  const result = execSafe('docker compose version');

  if (!result.ok) {
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();

    if (
      combined.includes('not found') ||
      combined.includes('is not recognized') ||
      combined.includes('no such file')
    ) {
      throw new Error(
        'Docker Compose is not installed or not in PATH. Install Docker Desktop from https://docker.com',
      );
    }

    if (combined.includes('cannot connect to the docker daemon')) {
      throw new Error(
        'Docker daemon is not running. Start Docker and try again.',
      );
    }

    throw new Error(
      `Docker Compose check failed: ${result.stderr || result.stdout}`,
    );
  }
}
