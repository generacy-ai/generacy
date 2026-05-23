import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { parse } from 'yaml';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { findGeneracyDir, getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';
import { upsertRegistryEntry } from '../cluster/registry.js';
import { reconcileWorkerCount } from '../cluster/worker-count-deriver.js';

/**
 * Returns true if any port entry uses the HOST:CONTAINER pattern (contains ':').
 */
export function hasLegacyPorts(ports: unknown[]): boolean {
  return ports.some((p) => typeof p === 'string' && p.includes(':'));
}

export function upCommand(): Command {
  return new Command('up')
    .description('Start the cluster (docker compose up -d)')
    .action(async () => {
      const logger = getLogger();
      ensureDocker();

      // Reconcile WORKER_COUNT from cluster.yaml → .env before compose reads
      // it. Runs before getClusterContext() so the strict ClusterYamlSchema
      // gate doesn't crash on edge values (workers: 0, malformed, missing).
      const generacyDir = findGeneracyDir();
      await reconcileWorkerCount(generacyDir, logger);

      const ctx = getClusterContext();

      // Check for legacy hardcoded port bindings
      try {
        const raw = readFileSync(ctx.composePath, 'utf-8');
        const compose = parse(raw);
        const ports = compose?.services?.cluster?.ports;
        if (Array.isArray(ports) && hasLegacyPorts(ports)) {
          logger.warn(
            "This cluster uses hardcoded port bindings (e.g., 3100:3100). " +
            "This prevents running multiple clusters simultaneously. " +
            "To fix: delete .generacy/docker-compose.yml and re-run 'generacy launch'.",
          );
        }
      } catch {
        // If we can't read/parse the compose file, skip the check — compose up will report errors
      }

      const result = runCompose(ctx, ['up', '-d']);
      if (!result.ok) {
        throw new Error(`Failed to start cluster: ${result.stderr || result.stdout}`);
      }
      upsertRegistryEntry(ctx);
      logger.info('Cluster started.');
    });
}
