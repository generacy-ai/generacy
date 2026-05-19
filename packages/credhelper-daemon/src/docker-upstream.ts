import fs from 'node:fs/promises';
import { constants } from 'node:fs';

import { CredhelperError } from './errors.js';

/**
 * Detect which Docker socket to use as upstream.
 *
 * Priority:
 *  1. DinD — /var/run/docker.sock  (when ENABLE_DIND=true)
 *  2. DooD — /var/run/docker-host.sock
 */
export async function detectUpstreamSocket(): Promise<{ socketPath: string; isHost: boolean }> {
  if (process.env.ENABLE_DIND === 'true') {
    try {
      await fs.access('/var/run/docker.sock', constants.W_OK);
      return { socketPath: '/var/run/docker.sock', isHost: false };
    } catch {
      // DinD socket not writable, fall through
    }
  }

  try {
    await fs.access('/var/run/docker-host.sock', constants.W_OK);
    return { socketPath: '/var/run/docker-host.sock', isHost: true };
  } catch {
    // DooD socket not writable either
  }

  throw new CredhelperError(
    'DOCKER_UPSTREAM_NOT_FOUND',
    'No Docker socket found: checked /var/run/docker.sock (DinD) and /var/run/docker-host.sock (DooD)',
  );
}
