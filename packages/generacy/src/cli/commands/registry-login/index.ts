import { Command } from 'commander';
import * as p from '@clack/prompts';
import { getClusterContext } from '../cluster/context.js';
import { readDockerConfig, writeDockerConfig, addAuth } from './docker-config.js';
import { isClusterRunning, forwardCredential } from './credential-forward.js';
import { getLogger } from '../../utils/logger.js';

export function registryLoginCommand(): Command {
  const command = new Command('registry-login');

  command
    .argument('<host>', 'Registry host (e.g., ghcr.io)')
    .description(
      `Authenticate with a private container registry for this project's cluster.
Credentials are scoped to this project directory and forwarded to the running
cluster's credhelper if available. To set machine-wide credentials, use
'docker login' directly.`,
    )
    .action(async (host: string) => {
      const logger = getLogger();
      const ctx = getClusterContext();

      const username = await p.text({
        message: 'Username',
        validate(input) {
          if (!input.trim()) return 'Username cannot be empty';
          return undefined;
        },
      });
      if (p.isCancel(username)) {
        p.cancel('Operation cancelled.');
        process.exit(130);
      }

      const password = await p.password({
        message: 'Token / password',
        validate(input) {
          if (!input.trim()) return 'Token/password cannot be empty';
          return undefined;
        },
      });
      if (p.isCancel(password)) {
        p.cancel('Operation cancelled.');
        process.exit(130);
      }

      // Write scoped Docker config
      let config = readDockerConfig(ctx.generacyDir);
      config = addAuth(config, host, username as string, password as string);
      writeDockerConfig(ctx.generacyDir, config);
      logger.info({ host }, 'Registry credentials saved to project-scoped Docker config');

      // Forward to running cluster if available
      if (isClusterRunning(ctx)) {
        const result = forwardCredential(ctx, host, username as string, password as string);
        if (result.ok) {
          logger.info({ host }, 'Credentials forwarded to cluster control-plane');
        } else {
          logger.warn({ host, stderr: result.stderr }, 'Failed to forward credentials to cluster (will apply on next restart)');
        }
      } else {
        logger.info('Cluster not running — credentials will be available on next start');
      }

      p.outro(`Registry credentials for ${host} saved.`);
    });

  return command;
}
