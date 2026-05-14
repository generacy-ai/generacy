import { execSafe } from '../../utils/exec.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Clear stale activation files from the generacy-data Docker volume.
 * Used when --claim is provided to ensure fresh activation on re-add.
 *
 * Removes: cluster-api-key, cluster.json, wizard-credentials.env
 * Non-fatal: returns false on failure (compose up will also fail).
 */
export function clearStaleActivation(composeName: string): boolean {
  const logger = getLogger();
  const volumeName = `${composeName}_generacy-data`;
  const cmd = `docker run --rm -v ${volumeName}:/v alpine rm -f /v/cluster-api-key /v/cluster.json /v/wizard-credentials.env`;

  logger.debug({ volumeName }, 'Clearing stale activation files from volume');

  const result = execSafe(cmd, { timeout: 30_000, stdio: 'pipe' });
  if (!result.ok) {
    logger.warn({ stderr: result.stderr }, 'Failed to clear stale activation files — cluster may reuse old credentials');
    return false;
  }
  return true;
}
