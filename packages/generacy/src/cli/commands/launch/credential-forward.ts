/**
 * Post-launch credential forwarding.
 *
 * After the cluster activates, forwards registry credentials from the
 * LaunchConfig into the cluster's credhelper via control-plane PUT requests,
 * then cleans up the local scoped Docker config.
 */
import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { RegistryCredential } from './types.js';

/** Compose file path relative to the project directory. */
const COMPOSE_FILE = '.generacy/docker-compose.yml';

/** Control-plane Unix socket path inside the container. */
const CONTROL_PLANE_SOCKET = '/run/generacy-control-plane/control.sock';

export interface ProbeOptions {
  retries?: number;
  intervalMs?: number;
}

/**
 * Probes the control-plane socket for HTTP readiness via docker compose exec.
 *
 * Retries up to `opts.retries` times (default 10) with `opts.intervalMs` delay
 * (default 2000ms) between attempts. Returns true once GET /state succeeds.
 */
export async function probeControlPlaneReady(
  projectDir: string,
  opts: ProbeOptions = {},
): Promise<boolean> {
  const retries = opts.retries ?? 10;
  const intervalMs = opts.intervalMs ?? 2000;

  for (let i = 0; i < retries; i++) {
    const result = spawnSync(
      'docker',
      [
        'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'orchestrator',
        'curl', '--unix-socket', CONTROL_PLANE_SOCKET, '-sf',
        'http://localhost/state',
      ],
      { cwd: projectDir, stdio: 'pipe' },
    );

    if (result.status === 0) {
      return true;
    }

    if (i < retries - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  return false;
}

export interface ForwardResult {
  forwarded: string[];
  failed: string[];
}

/**
 * Forwards registry credentials to the cluster's credhelper via
 * PUT /credentials/registry-<host> over docker compose exec curl.
 */
export function forwardRegistryCredentials(
  projectDir: string,
  credentials: RegistryCredential[],
): ForwardResult {
  const forwarded: string[] = [];
  const failed: string[] = [];

  for (const cred of credentials) {
    const credId = `registry-${cred.host}`;
    const auth = Buffer.from(`${cred.username}:${cred.password}`).toString('base64');
    const body = JSON.stringify({ type: 'registry', value: auth });

    const result = spawnSync(
      'docker',
      [
        'compose', '-f', COMPOSE_FILE, 'exec', '-T', 'orchestrator',
        'curl', '--unix-socket', CONTROL_PLANE_SOCKET, '-sf',
        '-X', 'PUT',
        `http://localhost/credentials/${credId}`,
        '-H', 'Content-Type: application/json',
        '-H', 'x-generacy-actor-user-id: system:cli-launch',
        '-d', body,
      ],
      { cwd: projectDir, stdio: 'pipe' },
    );

    if (result.status === 0) {
      forwarded.push(cred.host);
    } else {
      failed.push(cred.host);
    }
  }

  return { forwarded, failed };
}

/**
 * Removes the scoped Docker config directory created during image pull.
 * Idempotent — succeeds silently if the directory doesn't exist.
 */
export async function cleanupScopedDockerConfig(projectDir: string): Promise<void> {
  const dockerDir = resolve(projectDir, '.generacy', '.docker');
  await rm(dockerDir, { recursive: true, force: true });
}
