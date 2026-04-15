import type { LaunchRequestCredentials } from '@generacy-ai/credhelper';

const DEFAULT_WORKFLOW_UID = 1001;
const DEFAULT_WORKFLOW_GID = 1000;

/**
 * Build a `LaunchRequestCredentials` object from the configured credential role.
 * Returns `undefined` when no role is configured (legacy / no-credentials mode).
 */
export function buildLaunchCredentials(
  credentialRole: string | undefined,
): LaunchRequestCredentials | undefined {
  if (!credentialRole) return undefined;
  return {
    role: credentialRole,
    uid: Number(process.env['GENERACY_WORKFLOW_UID'] ?? DEFAULT_WORKFLOW_UID),
    gid: Number(process.env['GENERACY_WORKFLOW_GID'] ?? DEFAULT_WORKFLOW_GID),
  };
}
