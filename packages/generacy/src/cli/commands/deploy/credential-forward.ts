import { sshExec } from './ssh-client.js';
import type { SshTarget } from './types.js';
import type { RegistryCredential } from '../launch/types.js';
import type { Logger } from 'pino';

/** Control-plane Unix socket path inside the container. */
const CONTROL_PLANE_SOCKET = '/run/generacy-control-plane/control.sock';

export interface ForwardResult {
  forwarded: string[];
  failed: string[];
}

/**
 * Forward registry credentials to the cluster's credhelper via SSH.
 * Uses docker compose exec to reach control-plane Unix socket.
 * Soft-fails: returns ForwardResult with failed entries (does not throw).
 */
export function forwardCredentialsToCluster(
  target: SshTarget,
  remotePath: string,
  credentials: RegistryCredential[],
  logger: Logger,
): ForwardResult {
  const forwarded: string[] = [];
  const failed: string[] = [];

  for (const cred of credentials) {
    try {
      forwardSingleCredential(target, remotePath, cred);
      forwarded.push(cred.host);
      logger.debug(`Forwarded credential for ${cred.host}`);
    } catch (error) {
      failed.push(cred.host);
      logger.warn(
        { host: cred.host, error: error instanceof Error ? error.message : String(error) },
        `Failed to forward credential for ${cred.host}`,
      );
    }
  }

  return { forwarded, failed };
}

/**
 * Forward a single credential entry via SSH + docker compose exec + curl.
 * Throws on failure.
 */
function forwardSingleCredential(
  target: SshTarget,
  remotePath: string,
  credential: RegistryCredential,
): void {
  const credId = `registry-${credential.host}`;
  const auth = Buffer.from(`${credential.username}:${credential.password}`).toString('base64');
  const body = JSON.stringify({ type: 'registry', value: auth });

  // Escape single quotes in JSON body for shell
  const escapedBody = body.replace(/'/g, "'\\''");

  const command = `cd "${remotePath}" && docker compose exec -T orchestrator curl --unix-socket ${CONTROL_PLANE_SOCKET} -sf -X PUT "http://localhost/credentials/${credId}" -H "Content-Type: application/json" -d '${escapedBody}'`;

  sshExec(target, command);
}
