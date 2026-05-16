/**
 * Docker Compose orchestration for `generacy launch`.
 *
 * Handles image pulling, cluster startup, and log streaming to detect
 * the device-flow activation URL emitted by the orchestrator on first boot.
 */
import { execSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RegistryCredential } from './types.js';

/** Compose file path relative to the project directory. */
const COMPOSE_FILE = '.generacy/docker-compose.yml';

/**
 * Pull the cluster image via `docker compose pull`.
 *
 * When `registryCredentials` is provided, writes a scoped Docker config
 * directory with an auth entry for every host and passes `DOCKER_CONFIG`
 * to the subprocess. The scoped directory is always cleaned up in a
 * `finally` block.
 *
 * When no credentials are provided, runs with inherited env (ambient auth).
 *
 * @param projectDir - Absolute path to the project root.
 * @param registryCredentials - Optional registry credentials from LaunchConfig.
 * @throws {Error} If the pull command fails.
 */
export function pullImage(projectDir: string, registryCredentials?: RegistryCredential[]): void {
  if (!registryCredentials || registryCredentials.length === 0) {
    // No-creds path: use ambient Docker auth (existing behavior)
    try {
      execSync(`docker compose -f ${COMPOSE_FILE} pull`, {
        cwd: projectDir,
        stdio: 'pipe',
      });
    } catch (error) {
      throw parsePullError(error);
    }
    return;
  }

  // Scoped credentials path
  const dockerConfigDir = join(projectDir, '.docker');
  const configPath = join(dockerConfigDir, 'config.json');

  mkdirSync(dockerConfigDir, { recursive: true });
  const auths: Record<string, { auth: string }> = {};
  for (const cred of registryCredentials) {
    auths[cred.host] = {
      auth: Buffer.from(`${cred.username}:${cred.password}`).toString('base64'),
    };
  }
  const dockerConfig = JSON.stringify({ auths });
  writeFileSync(configPath, dockerConfig, { mode: 0o600 });

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} pull`, {
      cwd: projectDir,
      stdio: 'pipe',
      env: { ...process.env, DOCKER_CONFIG: dockerConfigDir },
    });
  } catch (error) {
    throw parsePullError(error);
  } finally {
    rmSync(dockerConfigDir, { recursive: true, force: true });
  }
}

/**
 * Parse Docker pull errors into actionable messages.
 */
function parsePullError(error: unknown): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  if (lower.includes('unauthorized') || lower.includes('authentication required') || lower.includes('denied')) {
    return new Error(
      `Registry authentication failed. Check that your registry credentials are valid.\n` +
      `  If using cloud-configured credentials, verify them in the Generacy dashboard.\n` +
      `  If using ambient Docker auth, run \`docker login\` for the target registry.`,
    );
  }

  if (lower.includes('manifest unknown') || lower.includes('not found')) {
    return new Error(
      `Image not found. The requested container image does not exist at the specified registry.\n` +
      `  Verify the image name and tag in your project configuration.`,
    );
  }

  return new Error(`docker compose pull failed: ${msg}`);
}

/**
 * Start the cluster in detached mode via `docker compose up -d`.
 *
 * Runs synchronously; throws on non-zero exit.
 *
 * @param projectDir - Absolute path to the project root.
 * @throws {Error} If the up command fails.
 */
export function startCluster(projectDir: string): void {
  try {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d`, {
      cwd: projectDir,
      stdio: 'pipe',
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`docker compose up failed: ${msg}`);
  }
}

/** Default timeout for waiting on activation output (120 seconds). */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Pattern to extract the verification URI from container logs.
 *
 * The orchestrator's pino logger emits its activation message as JSON, where
 * embedded newlines are encoded as literal `\n` two-character escape sequences.
 * `\S+` would greedily include those two chars in the captured URL, and the
 * trailing backslash gets rewritten by the OS / browser into a slash —
 * yielding e.g. `https://app/cluster-activate/n` (404).
 * Restrict to URL-safe characters so the capture stops at the backslash. */
const VERIFICATION_URI_RE = /Go to:\s+(https?:\/\/[^\s\\"']+)/;

/** Pattern to extract the user code from container logs.
 *
 * Same JSON-log concern as VERIFICATION_URI_RE — stop at quote/backslash
 * boundaries so the captured code doesn't trail off into the next field. */
const USER_CODE_RE = /Enter code:\s+([^\s\\"']+)/;

/**
 * Stream `docker compose logs -f` and watch for activation patterns.
 *
 * Resolves once both the verification URI (`Go to: <url>`) and user code
 * (`Enter code: <code>`) have been detected in stdout. Rejects if the
 * patterns are not matched within {@link DEFAULT_TIMEOUT_MS}.
 *
 * @param projectDir - Absolute path to the project root.
 * @param timeoutMs  - Maximum time to wait in milliseconds (default: 120 000).
 * @returns The extracted verification URI and user code.
 *
 * @throws {Error} If the timeout expires before both patterns are matched.
 */
export function streamLogsUntilActivation(
  projectDir: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ verificationUri: string; userCode: string }> {
  return new Promise((promiseResolve, reject) => {
    const child = spawn('docker', ['compose', '-f', COMPOSE_FILE, 'logs', '-f'], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let verificationUri: string | undefined;
    let userCode: string | undefined;
    let buffer = '';
    let settled = false;

    function cleanup(): void {
      if (!child.killed) {
        child.kill();
      }
    }

    function tryResolve(): void {
      if (settled) return;
      if (verificationUri && userCode) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        promiseResolve({ verificationUri, userCode });
      }
    }

    function processLine(line: string): void {
      if (settled) return;

      if (!verificationUri) {
        const uriMatch = VERIFICATION_URI_RE.exec(line);
        if (uriMatch) {
          verificationUri = uriMatch[1]!;
        }
      }

      if (!userCode) {
        const codeMatch = USER_CODE_RE.exec(line);
        if (codeMatch) {
          userCode = codeMatch[1]!;
        }
      }

      tryResolve();
    }

    function handleData(chunk: Buffer): void {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      // Keep the last element as it may be a partial line
      buffer = lines.pop()!;
      for (const line of lines) {
        processLine(line);
      }
    }

    child.stdout.on('data', handleData);
    child.stderr.on('data', handleData);

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        reject(new Error(`Failed to stream logs: ${err.message}`));
      }
    });

    child.on('close', () => {
      if (!settled) {
        // Process any remaining buffered content
        if (buffer.length > 0) {
          processLine(buffer);
          buffer = '';
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Log stream ended before activation URL was detected'));
        }
      }
    });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for activation URL`));
      }
    }, timeoutMs);
  });
}
