import { Command } from 'commander';
import * as p from '@clack/prompts';
import * as fs from 'node:fs';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { runCompose } from '../cluster/compose.js';
import { removeRegistryEntry } from '../cluster/registry.js';

export function destroyCommand(): Command {
  return new Command('destroy')
    .description('Destroy cluster: remove containers, volumes, and .generacy/ directory')
    .option('--yes', 'Skip confirmation prompt', false)
    .action(async (options: { yes: boolean }) => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();

      if (!options.yes) {
        const confirmed = await p.confirm({
          message: `Destroy cluster at ${ctx.projectRoot}? This removes all containers, volumes, and the .generacy/ directory.`,
        });
        if (p.isCancel(confirmed) || !confirmed) {
          p.log.info('Cancelled.');
          return;
        }
      }

      const result = runCompose(ctx, ['down', '-v']);
      if (!result.ok) {
        throw new Error(`Failed to destroy cluster: ${result.stderr || result.stdout}`);
      }

      fs.rmSync(ctx.generacyDir, { recursive: true, force: true });
      removeRegistryEntry(ctx.projectRoot);
      logger.info('Cluster destroyed.');
    });
}
