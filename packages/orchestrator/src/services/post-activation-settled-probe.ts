import { existsSync } from 'node:fs';

const DEFAULT_KEY_FILE_PATH = '/var/lib/generacy/cluster-api-key';
const DEFAULT_MARKER_PATH = '/var/lib/generacy/post-activation-restart-done';

export interface PostActivationSettledPaths {
  keyFilePath?: string;
  markerPath?: string;
}

/**
 * Returns whether the cluster has settled after its post-activation self-restart.
 *
 * Predicate: `(NOT activated) OR (marker present)`. Local `generacy launch`
 * clusters — which never activate against the cloud — are always settled.
 * Wizard clusters are settled once `entrypoint-post-activation.sh` writes the
 * marker (immediately before `docker restart`).
 *
 * Sync-only, side-effect-free. `existsSync` does not throw on permission
 * errors; it returns `false`.
 */
export function isPostActivationSettledSync(paths?: PostActivationSettledPaths): boolean {
  const keyFilePath = paths?.keyFilePath ?? DEFAULT_KEY_FILE_PATH;
  const markerPath = paths?.markerPath ?? DEFAULT_MARKER_PATH;
  const activated = existsSync(keyFilePath);
  const markerPresent = existsSync(markerPath);
  return !activated || markerPresent;
}
