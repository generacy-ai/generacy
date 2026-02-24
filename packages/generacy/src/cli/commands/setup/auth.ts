/**
 * Setup auth subcommand.
 * Configures git credentials and GitHub CLI authentication.
 * Replaces .devcontainer/ensure-auth.sh
 */
import { Command } from 'commander';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../../utils/logger.js';
import { exec, execSafe } from '../../utils/exec.js';

/**
 * Auth configuration resolved from CLI args and environment variables.
 */
interface AuthConfig {
  email?: string;
  username?: string;
  token?: string;
}

/**
 * Resolve auth config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveAuthConfig(cliArgs: Partial<AuthConfig>): AuthConfig {
  return {
    email: cliArgs.email ?? process.env['GH_EMAIL'],
    username: cliArgs.username ?? process.env['GH_USERNAME'],
    token: cliArgs.token ?? process.env['GH_TOKEN'],
  };
}

/**
 * Create the `setup auth` subcommand.
 */
export function setupAuthCommand(): Command {
  const command = new Command('auth');

  command
    .description('Configure git credentials and GitHub CLI authentication')
    .option('--email <email>', 'Git user email (or GH_EMAIL env)')
    .option('--username <name>', 'Git user name (or GH_USERNAME env)')
    .action(async (options) => {
      const logger = getLogger();
      const config = resolveAuthConfig(options);

      logger.info('Configuring CLI authentication');

      // Step 1: Configure git identity
      if (config.username && config.email) {
        exec(`git config --global user.name "${config.username}"`);
        exec(`git config --global user.email "${config.email}"`);
        logger.info(
          { username: config.username, email: config.email },
          'Git user configured',
        );
      } else {
        if (config.username) {
          exec(`git config --global user.name "${config.username}"`);
          logger.info({ username: config.username }, 'Git user.name configured');
        }
        if (config.email) {
          exec(`git config --global user.email "${config.email}"`);
          logger.info({ email: config.email }, 'Git user.email configured');
        }
        if (!config.username) {
          logger.warn('GH_USERNAME not set — git user.name not configured');
        }
        if (!config.email) {
          logger.warn('GH_EMAIL not set — git user.email not configured');
        }
      }

      // Step 2: Configure git credential helper
      if (config.token) {
        exec('git config --global credential.helper store');

        const home = homedir();
        mkdirSync(home, { recursive: true });
        const credentialsPath = join(home, '.git-credentials');
        const credentialUser = config.username ?? 'git';
        writeFileSync(
          credentialsPath,
          `https://${credentialUser}:${config.token}@github.com\n`,
          { mode: 0o600 },
        );
        logger.info('Git credentials configured for github.com');
      } else {
        logger.warn(
          'GH_TOKEN not set — git push/pull to private repos will require manual authentication',
        );
      }

      // Step 3: Configure gh CLI auth
      if (config.token) {
        const authCheck = execSafe('gh auth status');
        if (authCheck.ok) {
          logger.info('GitHub CLI authenticated via GH_TOKEN env var');
        } else {
          // Pipe token to gh auth login
          const loginResult = execSafe(
            `echo "${config.token}" | gh auth login --with-token`,
          );
          if (loginResult.ok) {
            logger.info('GitHub CLI authenticated via GH_TOKEN');
          } else {
            logger.error(
              { stderr: loginResult.stderr },
              'Failed to authenticate GitHub CLI',
            );
          }
        }
      } else {
        const authCheck = execSafe('gh auth status');
        if (authCheck.ok) {
          logger.info('GitHub CLI is authenticated');
        } else {
          logger.warn(
            'GitHub CLI is not authenticated — set GH_TOKEN in agent.env or run: gh auth login',
          );
        }
      }

      // Step 4: Verify authentication
      const verification = execSafe('gh auth status');
      if (verification.ok) {
        logger.info(
          { stdout: verification.stdout },
          'Authentication verified',
        );
      } else {
        logger.error(
          { stderr: verification.stderr },
          'Authentication verification failed',
        );
        process.exit(1);
      }
    });

  return command;
}
