import { Command } from 'commander';
import { getLogger } from '../../utils/logger.js';
import { ensureDocker } from '../cluster/docker.js';
import { getClusterContext } from '../cluster/context.js';
import { lifecycleAction, runCompose } from '../cluster/compose.js';

export function downCommand(): Command {
  return new Command('down')
    .description('Remove cluster containers (named volumes preserved unless --volumes)')
    .option('--volumes', 'Also remove named volumes', false)
    .action(async (options: { volumes: boolean }) => {
      const logger = getLogger();
      ensureDocker();
      const ctx = getClusterContext();

      // Best-effort: pause the VS Code tunnel before compose down so the
      // tunnel process exits cleanly (FR-009).
      lifecycleAction(ctx, 'vscode-tunnel-stop');

      const args = ['down'];
      if (options.volumes) {
        args.push('--volumes');
      }
      const result = runCompose(ctx, args);
      if (!result.ok) {
        throw new Error(`Failed to bring down cluster: ${result.stderr || result.stdout}`);
      }
      logger.info('Cluster removed.');
    });
}
