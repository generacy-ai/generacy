import { Command } from 'commander';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';
import { upsertRegistryEntry } from '../cluster/registry.js';

export function updateCommand(): Command {
  return new Command('update')
    .description('Pull latest images and recreate changed containers')
    .action(async () => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();

      const pullResult = runCompose(ctx, ['pull']);
      if (!pullResult.ok) {
        throw new Error(`Failed to pull images: ${pullResult.stderr || pullResult.stdout}`);
      }

      const upResult = runCompose(ctx, ['up', '-d']);
      if (!upResult.ok) {
        throw new Error(`Failed to recreate containers: ${upResult.stderr || upResult.stdout}`);
      }

      upsertRegistryEntry(ctx);
      logger.info('Cluster updated.');
    });
}
