import { scpDirectory, sshExec } from './ssh-client.js';
import { DeployError, type SshTarget } from './types.js';
import { getLogger } from '../../utils/logger.js';
import { writeRemoteDockerConfig, cleanupRemoteDockerConfig } from './remote-credentials.js';
import type { RegistryCredential } from '../launch/types.js';

/**
 * Transfer bootstrap bundle to remote host and start docker compose.
 */
export function deployToRemote(
  target: SshTarget,
  bundleDir: string,
  remotePath: string,
  registryCredentials?: RegistryCredential[],
): void {
  const logger = getLogger();

  // SCP the bundle
  logger.info(`Transferring files to ${target.host}:${remotePath}`);
  scpDirectory(target, bundleDir, remotePath);

  // Write remote Docker config for authenticated pull if credentials present
  const hasCredentials = registryCredentials && registryCredentials.length > 0;
  if (hasCredentials) {
    logger.info('Writing registry credentials to remote host...');
    writeRemoteDockerConfig(target, remotePath, registryCredentials);
  }

  // Pull images
  logger.info('Pulling Docker images on remote host...');
  try {
    const pullCommand = hasCredentials
      ? `cd "${remotePath}" && DOCKER_CONFIG="${remotePath}/.docker" docker compose pull`
      : `cd "${remotePath}" && docker compose pull`;
    sshExec(target, pullCommand);
  } catch (error) {
    throw new DeployError(
      `Failed to pull images on ${target.host}: ${error instanceof Error ? error.message : String(error)}`,
      'PULL_FAILED',
      error instanceof Error ? error : undefined,
    );
  } finally {
    // Always clean up remote Docker config regardless of pull outcome
    if (hasCredentials) {
      logger.debug('Cleaning up remote Docker credentials...');
      cleanupRemoteDockerConfig(target, remotePath);
    }
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
