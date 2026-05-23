import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Logger } from 'pino';
import { readMergedClusterConfig } from '@generacy-ai/config';

export interface DeriveResult {
  workerCount: number;
  source: 'cluster.yaml' | 'cluster.local.yaml' | 'clamped' | 'default';
  warnings: string[];
}

export interface SyncEnvResult {
  wrote: boolean;
  reason?: 'env-missing' | 'write-failed';
  error?: Error;
}

const RawClusterYamlSchema = z
  .object({
    workers: z.unknown(),
  })
  .partial();

function atomicWriteSync(targetPath: string, content: string): void {
  const tmpPath = join(dirname(targetPath), `.${randomBytes(8).toString('hex')}.tmp`);
  writeFileSync(tmpPath, content, { mode: 0o644 });
  renameSync(tmpPath, targetPath);
}

function classifyWorkers(
  raw: unknown,
  sourceName: 'cluster.yaml' | 'cluster.local.yaml',
): DeriveResult {
  if (raw === undefined) {
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`${sourceName} has no workers field; using default 1`],
    };
  }
  if (raw === null) {
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`${sourceName} workers field is malformed (got: null); using default 1`],
    };
  }
  if (typeof raw === 'number' && Number.isInteger(raw)) {
    if (raw > 0) {
      return { workerCount: raw, source: sourceName, warnings: [] };
    }
    return {
      workerCount: 1,
      source: 'clamped',
      warnings: [`${sourceName} has workers: ${raw}; clamping to 1`],
    };
  }
  const displayValue =
    typeof raw === 'string'
      ? `"${raw}"`
      : Array.isArray(raw)
        ? 'array'
        : typeof raw === 'object'
          ? 'object'
          : String(raw);
  return {
    workerCount: 1,
    source: 'default',
    warnings: [`${sourceName} workers field is malformed (got: ${displayValue}); using default 1`],
  };
}

function readLooseWorkers(filePath: string): { exists: boolean; workers: unknown } {
  if (!existsSync(filePath)) return { exists: false, workers: undefined };
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return { exists: true, workers: undefined };
  }
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch {
    return { exists: true, workers: undefined };
  }
  const parsed = RawClusterYamlSchema.safeParse(raw ?? {});
  return { exists: true, workers: parsed.success ? parsed.data.workers : undefined };
}

function readCanonicalOnly(generacyDir: string): DeriveResult {
  const yamlPath = join(generacyDir, 'cluster.yaml');
  if (!existsSync(yamlPath)) {
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`cluster.yaml not found at ${yamlPath}; using default 1`],
    };
  }

  let content: string;
  try {
    content = readFileSync(yamlPath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`cluster.yaml unreadable at ${yamlPath} (${msg}); using default 1`],
    };
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`cluster.yaml is not valid YAML (${msg}); using default 1`],
    };
  }

  const parsed = RawClusterYamlSchema.safeParse(raw ?? {});
  const workers: unknown = parsed.success ? parsed.data.workers : undefined;
  return classifyWorkers(workers, 'cluster.yaml');
}

export async function deriveWorkerCount(
  generacyDir: string,
  _logger: Logger,
): Promise<DeriveResult> {
  const canonicalPath = join(generacyDir, 'cluster.yaml');
  const localPath = join(generacyDir, 'cluster.local.yaml');

  try {
    const { canonical, local } = await readMergedClusterConfig(generacyDir);

    if (typeof local.workers === 'number') {
      const warnings: string[] = [];
      if (!existsSync(canonicalPath)) {
        warnings.push(
          `cluster.yaml not found at ${canonicalPath}; using cluster.local.yaml value (workers: ${local.workers}). Run 'npx generacy init' to restore the template config.`,
        );
      }
      return { workerCount: local.workers, source: 'cluster.local.yaml', warnings };
    }

    if (typeof canonical.workers === 'number') {
      return { workerCount: canonical.workers, source: 'cluster.yaml', warnings: [] };
    }

    if (!existsSync(canonicalPath)) {
      return {
        workerCount: 1,
        source: 'default',
        warnings: [`cluster.yaml not found at ${canonicalPath}; using default 1`],
      };
    }
    return {
      workerCount: 1,
      source: 'default',
      warnings: [`cluster.yaml has no workers field; using default 1`],
    };
  } catch {
    const localLoose = readLooseWorkers(localPath);
    const warnings: string[] = [];
    if (localLoose.exists) {
      warnings.push('cluster.local.yaml unreadable; using cluster.yaml value');
    }
    if (
      typeof localLoose.workers === 'number' &&
      Number.isInteger(localLoose.workers) &&
      localLoose.workers > 0
    ) {
      return { workerCount: localLoose.workers, source: 'cluster.local.yaml', warnings };
    }
    const canonicalResult = readCanonicalOnly(generacyDir);
    return { ...canonicalResult, warnings: [...warnings, ...canonicalResult.warnings] };
  }
}

export function syncEnvWorkerCount(
  generacyDir: string,
  workerCount: number,
  logger: Logger,
): SyncEnvResult {
  const envPath = join(generacyDir, '.env');
  if (!existsSync(envPath)) {
    logger.warn(`WORKER_COUNT sync to .env skipped: file not found at ${envPath}`);
    return { wrote: false, reason: 'env-missing' };
  }

  let existing: string;
  try {
    existing = readFileSync(envPath, 'utf-8');
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(`WORKER_COUNT sync to .env failed: ${error.message}; cluster.yaml is the source of truth`);
    return { wrote: false, reason: 'write-failed', error };
  }

  const next = applyWorkerCountToEnv(existing, workerCount);

  try {
    atomicWriteSync(envPath, next);
    return { wrote: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.warn(`WORKER_COUNT sync to .env failed: ${error.message}; cluster.yaml is the source of truth`);
    return { wrote: false, reason: 'write-failed', error };
  }
}

export function applyWorkerCountToEnv(existing: string, workerCount: number): string {
  const line = `WORKER_COUNT=${workerCount}`;
  const pattern = /^WORKER_COUNT=.*$/m;
  if (pattern.test(existing)) {
    return existing.replace(pattern, line);
  }
  if (existing.length === 0) {
    return `${line}\n`;
  }
  return existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`;
}

export async function reconcileWorkerCount(
  generacyDir: string,
  logger: Logger,
): Promise<{ workerCount: number; envWrote: boolean }> {
  const derived = await deriveWorkerCount(generacyDir, logger);
  for (const warning of derived.warnings) {
    logger.warn(warning);
  }

  const sync = syncEnvWorkerCount(generacyDir, derived.workerCount, logger);

  if (sync.wrote) {
    if (derived.source === 'cluster.local.yaml') {
      logger.info(`Reconciled WORKER_COUNT from cluster.local.yaml: ${derived.workerCount}`);
    } else {
      logger.info(`Reconciled WORKER_COUNT from cluster.yaml: ${derived.workerCount}`);
    }
  }

  return { workerCount: derived.workerCount, envWrote: sync.wrote };
}
