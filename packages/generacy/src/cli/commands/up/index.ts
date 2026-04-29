import { Command } from 'commander';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';
import { upsertRegistryEntry } from '../cluster/registry.js';

export function upCommand(): Command {
  return new Command('up')
    .description('Start the cluster (docker compose up -d)')
    .action(async () => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();
      const result = runCompose(ctx, ['up', '-d']);
      if (!result.ok) {
        throw new Error(`Failed to start cluster: ${result.stderr || result.stdout}`);
      }
      upsertRegistryEntry(ctx);
      logger.info('Cluster started.');
    });
}
