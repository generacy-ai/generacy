import { readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { resolveGeneracyDir } from './project-dir-resolver.js';

export interface ScaleResult {
  previousCount: number;
  requestedCount: number;
}

export interface ScaleOptions {
  count: number;
  orchestratorUrl?: string;
  orchestratorApiKey?: string;
}

/**
 * Scale worker replicas by updating .env, cluster.yaml, and running docker compose.
 */
export async function scaleWorkers(options: ScaleOptions): Promise<ScaleResult> {
  const { count } = options;
  const orchestratorUrl = options.orchestratorUrl ?? process.env['ORCHESTRATOR_URL'] ?? 'http://127.0.0.1:3100';
  const orchestratorApiKey = options.orchestratorApiKey ?? process.env['ORCHESTRATOR_INTERNAL_API_KEY'];

  const generacyDir = await resolveGeneracyDir();
  const envPath = join(generacyDir, '.env');
  const yamlPath = join(generacyDir, 'cluster.yaml');
  const composePath = join(generacyDir, 'docker-compose.yml');

  // 1. Read current count from .env
  const previousCount = await readCurrentCount(envPath);

  // 2. Update .env atomically
  await updateEnvFile(envPath, count);

  // 3. Update cluster.yaml atomically
  await updateClusterYaml(yamlPath, count);

  // 4. Execute docker compose scale
  await execDockerScale(composePath, count);

  // 5. Trigger metadata refresh (best-effort)
  if (orchestratorApiKey) {
    triggerMetadataRefresh(orchestratorUrl, orchestratorApiKey).catch(() => {
      // Non-fatal: metadata will refresh on the next periodic cycle
    });
  }

  return { previousCount, requestedCount: count };
}

/**
 * Read current WORKER_COUNT from .env file. Returns 1 if missing or unparseable.
 */
export async function readCurrentCount(envPath: string): Promise<number> {
  try {
    const content = await readFile(envPath, 'utf-8');
    const match = content.match(/^WORKER_COUNT=(\d+)$/m);
    if (match?.[1]) {
      return parseInt(match[1], 10);
    }
  } catch {
    // File doesn't exist — default to 1
  }
  return 1;
}

/**
 * Update WORKER_COUNT in .env file. Appends the line if it doesn't exist.
 * Uses atomic write (temp + rename).
 */
export async function updateEnvFile(envPath: string, count: number): Promise<void> {
  let content: string;
  try {
    content = await readFile(envPath, 'utf-8');
  } catch {
    content = '';
  }

  const line = `WORKER_COUNT=${count}`;
  if (/^WORKER_COUNT=\d+$/m.test(content)) {
    content = content.replace(/^WORKER_COUNT=\d+$/m, line);
  } else {
    // Append with newline if file doesn't end with one
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    content = content + separator + line + '\n';
  }

  await atomicWrite(envPath, content);
}

/**
 * Update the `workers` field in cluster.yaml atomically.
 */
export async function updateClusterYaml(yamlPath: string, count: number): Promise<void> {
  let doc: Record<string, unknown>;
  try {
    const content = await readFile(yamlPath, 'utf-8');
    doc = (parseYaml(content) as Record<string, unknown>) ?? {};
  } catch {
    doc = {};
  }

  doc.workers = count;
  const output = stringifyYaml(doc);
  await atomicWrite(yamlPath, output);
}

/**
 * Execute `docker compose up -d --scale worker=<n>`.
 * The compose file's top-level `name:` field ensures correct project name.
 */
export async function execDockerScale(composePath: string, count: number): Promise<void> {
  const dockerHost = process.env['DOCKER_HOST'] ?? 'unix:///var/run/docker-host.sock';

  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      ['compose', '-f', composePath, 'up', '-d', '--scale', `worker=${count}`],
      {
        env: { ...process.env, DOCKER_HOST: dockerHost },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('DOCKER_CLI_UNAVAILABLE'));
      } else {
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`docker compose exited with code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

/**
 * POST to orchestrator /internal/refresh-metadata to trigger immediate metadata push.
 */
export async function triggerMetadataRefresh(
  orchestratorUrl: string,
  apiKey: string,
): Promise<void> {
  const response = await fetch(`${orchestratorUrl}/internal/refresh-metadata`, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`refresh-metadata returned ${response.status}`);
  }
}

/**
 * Atomic file write: write to temp file, then rename.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(targetPath), `.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(tmpPath, content, { mode: 0o644 });
  await rename(tmpPath, targetPath);
}
