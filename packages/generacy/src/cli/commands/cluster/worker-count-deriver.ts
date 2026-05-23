import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Logger } from 'pino';

export interface DeriveResult {
  workerCount: number;
  source: 'cluster.yaml' | 'clamped' | 'default';
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

export function deriveWorkerCount(generacyDir: string, _logger: Logger): DeriveResult {
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

  if (workers === undefined || workers === null) {
    const reason =
      workers === null
        ? `cluster.yaml workers field is malformed (got: null); using default 1`
        : `cluster.yaml has no workers field; using default 1`;
    return { workerCount: 1, source: 'default', warnings: [reason] };
  }

  if (typeof workers === 'number' && Number.isInteger(workers)) {
    if (workers > 0) {
      return { workerCount: workers, source: 'cluster.yaml', warnings: [] };
    }
    return {
      workerCount: 1,
      source: 'clamped',
      warnings: [`cluster.yaml has workers: ${workers}; clamping to 1`],
    };
  }

  const displayValue =
    typeof workers === 'string'
      ? `"${workers}"`
      : Array.isArray(workers)
        ? 'array'
        : typeof workers === 'object'
          ? 'object'
          : String(workers);

  return {
    workerCount: 1,
    source: 'default',
    warnings: [`cluster.yaml workers field is malformed (got: ${displayValue}); using default 1`],
  };
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

export function reconcileWorkerCount(
  generacyDir: string,
  logger: Logger,
): { workerCount: number; envWrote: boolean } {
  const derived = deriveWorkerCount(generacyDir, logger);
  for (const warning of derived.warnings) {
    logger.warn(warning);
  }

  if (derived.source !== 'cluster.yaml') {
    const yamlPath = join(generacyDir, 'cluster.yaml');
    try {
      let doc: Record<string, unknown> = {};
      if (existsSync(yamlPath)) {
        try {
          const stat = statSync(yamlPath);
          if (stat.isFile()) {
            const content = readFileSync(yamlPath, 'utf-8');
            const parsed = parseYaml(content);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              doc = parsed as Record<string, unknown>;
            }
          }
        } catch {
          doc = {};
        }
      }
      doc.workers = derived.workerCount;
      atomicWriteSync(yamlPath, stringifyYaml(doc));
      logger.info(`Reconciled cluster.yaml workers to ${derived.workerCount}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to rewrite cluster.yaml workers: ${msg}; cluster.yaml is the source of truth`);
    }
  }

  const sync = syncEnvWorkerCount(generacyDir, derived.workerCount, logger);

  if (sync.wrote) {
    logger.info(`Reconciled WORKER_COUNT from cluster.yaml: ${derived.workerCount}`);
  }

  return { workerCount: derived.workerCount, envWrote: sync.wrote };
}
