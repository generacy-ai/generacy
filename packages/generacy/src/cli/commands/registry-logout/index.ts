import { Command } from 'commander';
import * as p from '@clack/prompts';
import { getClusterContext } from '../cluster/context.js';
import { readDockerConfig, writeDockerConfig, removeAuth } from '../registry-login/docker-config.js';
import { isClusterRunning, removeCredential } from '../registry-login/credential-forward.js';
import { getLogger } from '../../utils/logger.js';

export function registryLogoutCommand(): Command {
  const command = new Command('registry-logout');

  command
    .argument('<host>', 'Registry host (e.g., ghcr.io)')
    .description('Remove registry credentials for this project (scoped config and cluster).')
    .action(async (host: string) => {
      const logger = getLogger();
      const ctx = getClusterContext();

      // Remove from scoped Docker config
      let config = readDockerConfig(ctx.generacyDir);
      config = removeAuth(config, host);
      writeDockerConfig(ctx.generacyDir, config);
      logger.info({ host }, 'Registry credentials removed from project-scoped Docker config');

      // Remove from running cluster if available
      if (isClusterRunning(ctx)) {
        const result = removeCredential(ctx, host);
        if (result.ok) {
          logger.info({ host }, 'Credentials removed from cluster control-plane');
        } else {
          logger.warn({ host, stderr: result.stderr }, 'Failed to remove credentials from cluster');
        }
      }

      p.outro(`Registry credentials for ${host} removed.`);
    });

  return command;
}
