import { Command } from 'commander';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';

export function stopCommand(): Command {
  return new Command('stop')
    .description('Stop the cluster (containers preserved)')
    .action(async () => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();
      const result = runCompose(ctx, ['stop']);
      if (!result.ok) {
        throw new Error(`Failed to stop cluster: ${result.stderr || result.stdout}`);
      }
      logger.info('Cluster stopped.');
    });
}
