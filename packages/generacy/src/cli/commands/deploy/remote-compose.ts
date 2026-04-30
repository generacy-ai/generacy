import { scpDirectory, sshExec } from './ssh-client.js';
import { DeployError, type SshTarget } from './types.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Transfer bootstrap bundle to remote host and start docker compose.
 */
export function deployToRemote(
  target: SshTarget,
  bundleDir: string,
  remotePath: string,
): void {
  const logger = getLogger();

  // SCP the bundle
  logger.info(`Transferring files to ${target.host}:${remotePath}`);
  scpDirectory(target, bundleDir, remotePath);

  // Pull images
  logger.info('Pulling Docker images on remote host...');
  try {
    sshExec(target, `cd "${remotePath}" && docker compose pull`);
  } catch (error) {
    throw new DeployError(
      `Failed to pull images on ${target.host}: ${error instanceof Error ? error.message : String(error)}`,
      'PULL_FAILED',
      error instanceof Error ? error : undefined,
    );
  }

  // Start services
  logger.info('Starting services on remote host...');
  try {
    sshExec(target, `cd "${remotePath}" && docker compose up -d`);
  } catch (error) {
    throw new DeployError(
      `Failed to start services on ${target.host}: ${error instanceof Error ? error.message : String(error)}`,
      'COMPOSE_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}
