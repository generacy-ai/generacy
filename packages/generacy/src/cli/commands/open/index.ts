import { Command } from 'commander';
import { getClusterContext } from '../../utils/cluster-context.js';
import { openUrl } from '../../utils/browser.js';

export function openCommand(): Command {
  const command = new Command('open');

  command
    .description('Open the cluster project page in your browser')
    .option('--cluster <id>', 'Cluster ID to open (from registry)')
    .action(async (options: { cluster?: string }) => {
      const context = await getClusterContext({
        clusterId: options.cluster,
      });

      const url = `${context.cloudUrl}/clusters/${context.clusterId}`;
      openUrl(url);
    });

  return command;
}
