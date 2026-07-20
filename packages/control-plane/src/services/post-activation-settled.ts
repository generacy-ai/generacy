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
 * Predicate: `(NOT activated) OR (marker present)` — identical to the
 * orchestrator-side probe in shape so the two processes cannot diverge in
 * interpretation. Local `generacy launch` clusters (no key file) always
 * return `true`; wizard clusters return `true` once
 * `entrypoint-post-activation.sh` writes the marker.
 *
 * Sync-only, side-effect-free.
 */
export function isPostActivationSettledSync(paths?: PostActivationSettledPaths): boolean {
  const keyFilePath = paths?.keyFilePath ?? DEFAULT_KEY_FILE_PATH;
  const markerPath = paths?.markerPath ?? DEFAULT_MARKER_PATH;
  const activated = existsSync(keyFilePath);
  const markerPresent = existsSync(markerPath);
  return !activated || markerPresent;
}
