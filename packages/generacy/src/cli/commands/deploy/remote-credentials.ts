import { sshExec, sshExecWithInput } from './ssh-client.js';
import { DeployError, type SshTarget } from './types.js';
import type { RegistryCredential } from '../launch/types.js';

/**
 * Build Docker config.json content from registry credential entries.
 */
export function buildDockerConfigJson(credentials: RegistryCredential[]): string {
  const auths: Record<string, { auth: string }> = {};
  for (const cred of credentials) {
    auths[cred.host] = {
      auth: Buffer.from(`${cred.username}:${cred.password}`).toString('base64'),
    };
  }
  return JSON.stringify({ auths }, null, 2);
}

/**
 * Write a scoped Docker config.json to the remote host via SSH stdin pipe.
 * Creates <remotePath>/.docker/config.json with mode 0600.
 */
export function writeRemoteDockerConfig(
  target: SshTarget,
  remotePath: string,
  credentials: RegistryCredential[],
): void {
  const configJson = buildDockerConfigJson(credentials);
  const command = `mkdir -p "${remotePath}/.docker" && cat > "${remotePath}/.docker/config.json" && chmod 600 "${remotePath}/.docker/config.json"`;

  try {
    sshExecWithInput(target, command, configJson);
  } catch (error) {
    throw new DeployError(
      `Failed to write Docker credentials to remote: ${error instanceof Error ? error.message : String(error)}`,
      'CREDENTIAL_WRITE_FAILED',
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Remove the scoped Docker config from the remote host.
 * Idempotent — tolerates missing file/directory.
 */
export function cleanupRemoteDockerConfig(
  target: SshTarget,
  remotePath: string,
): void {
  try {
    sshExec(target, `rm -f "${remotePath}/.docker/config.json" && rmdir "${remotePath}/.docker" 2>/dev/null || true`);
  } catch {
    // Cleanup is best-effort — don't fail the deploy
  }
}
