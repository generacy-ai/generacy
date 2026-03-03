/**
 * Setup workspace subcommand.
 * Clones all required repositories and installs their dependencies.
 * Replaces .devcontainer/setup-repos.sh
 */
import { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getLogger } from '../../utils/logger.js';
import { exec, execSafe } from '../../utils/exec.js';

/**
 * Workspace configuration resolved from CLI args and environment variables.
 */
interface WorkspaceConfig {
  repos: string[];
  branch: string;
  workdir: string;
  clean: boolean;
  githubOrg: string;
}

/**
 * Default repositories to clone.
 */
const DEFAULT_REPOS = [
  'tetrad-development',
  'contracts',
  'cluster-templates',
  'latency',
  'agency',
  'generacy',
  'humancy',
  'generacy-cloud',
  'humancy-cloud',
];

/**
 * CLI options as parsed by Commander (repos is a comma-separated string).
 */
interface WorkspaceCliOptions {
  repos?: string;
  branch?: string;
  workdir?: string;
  clean?: boolean;
}

/**
 * Resolve workspace config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveWorkspaceConfig(cliArgs: WorkspaceCliOptions): WorkspaceConfig {
  const envRepos = process.env['REPOS'];
  const cliRepos = cliArgs.repos;

  let repos: string[];
  if (cliRepos) {
    repos = cliRepos.split(',').map((r) => r.trim()).filter(Boolean);
  } else if (envRepos) {
    repos = envRepos.split(',').map((r) => r.trim()).filter(Boolean);
  } else {
    repos = [...DEFAULT_REPOS];
  }

  const branch =
    cliArgs.branch ??
    process.env['REPO_BRANCH'] ??
    process.env['DEFAULT_BRANCH'] ??
    'develop';

  const cleanEnv = process.env['CLEAN_REPOS'];
  const clean = cliArgs.clean ?? (cleanEnv === 'true');

  return {
    repos,
    branch,
    workdir: cliArgs.workdir ?? '/workspaces',
    clean,
    githubOrg: process.env['GITHUB_ORG'] ?? 'generacy-ai',
  };
}

/**
 * Detect the package manager for a repository.
 * Returns 'pnpm' if pnpm-lock.yaml exists, otherwise 'npm'.
 */
function detectPackageManager(repoPath: string): 'pnpm' | 'npm' {
  return existsSync(join(repoPath, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm';
}

/**
 * Ensure git credentials are configured.
 * Checks for existing credentials or GH_TOKEN, sets up if needed.
 */
function ensureGitCredentials(): void {
  const logger = getLogger();

  const ghAuth = execSafe('gh auth status');
  if (ghAuth.ok) {
    logger.info('gh CLI is authenticated, configuring git to use gh credentials');
    execSafe('gh auth setup-git');
    return;
  }

  const token = process.env['GH_TOKEN'];
  if (token) {
    logger.info('gh not authenticated, using GH_TOKEN directly');
    exec('git config --global credential.helper store');
    const username = process.env['GH_USERNAME'] ?? 'git';
    const home = homedir();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, '.git-credentials'),
      `https://${username}:${token}@github.com\n`,
      { mode: 0o600 },
    );
    logger.info('Git credentials configured from GH_TOKEN');

    // Also configure gh CLI
    execSafe(`echo "${token}" | gh auth login --with-token`);
    return;
  }

  // Check if .git-credentials exists
  if (existsSync(join(homedir(), '.git-credentials'))) {
    logger.debug('Git credentials file already exists');
    return;
  }

  logger.warn('No credentials available — relying on credential forwarding');
}

/**
 * Clone or update a single repository.
 * Returns true on success, false on failure.
 */
function cloneOrUpdateRepo(
  repo: string,
  config: WorkspaceConfig,
): boolean {
  const logger = getLogger();
  const target = join(config.workdir, repo);

  if (existsSync(join(target, '.git'))) {
    // Update existing repo
    logger.info({ repo }, 'Repository exists, updating');

    if (config.clean) {
      logger.info({ repo }, 'Cleaning repository (--clean)');
      execSafe('git reset --hard HEAD', { cwd: target });
      execSafe('git clean -fd', { cwd: target });
    }

    execSafe('git fetch origin', { cwd: target });

    // Check current branch and switch if needed
    const currentBranch = execSafe('git branch --show-current', { cwd: target });
    if (currentBranch.ok && currentBranch.stdout !== config.branch) {
      logger.info(
        { repo, from: currentBranch.stdout, to: config.branch },
        'Switching branch',
      );
      const checkout = execSafe(`git checkout ${config.branch}`, { cwd: target });
      if (!checkout.ok) {
        execSafe(
          `git checkout -b ${config.branch} origin/${config.branch}`,
          { cwd: target },
        );
      }
    }

    execSafe(`git pull origin ${config.branch}`, { cwd: target });
    return true;
  }

  // Clone new repo
  logger.info({ repo, branch: config.branch }, 'Cloning repository');

  const cloneUrl = `https://github.com/${config.githubOrg}/${repo}.git`;

  // Try clone with specified branch
  const clone = execSafe(
    `git clone --branch ${config.branch} ${cloneUrl} ${target}`,
  );
  if (clone.ok) {
    logger.info({ repo }, 'Repository cloned successfully');
    return true;
  }

  // Fallback: clone without branch (uses default branch)
  logger.info({ repo }, 'Branch not found, cloning default branch');
  const fallback = execSafe(`git clone ${cloneUrl} ${target}`);
  if (fallback.ok) {
    logger.info({ repo }, 'Repository cloned successfully (default branch)');
    return true;
  }

  logger.error({ repo, stderr: fallback.stderr }, 'Failed to clone repository');
  return false;
}

/**
 * Install dependencies for a repository.
 */
function installDeps(repo: string, workdir: string): void {
  const logger = getLogger();
  const target = join(workdir, repo);

  if (!existsSync(join(target, 'package.json'))) {
    logger.debug({ repo }, 'No package.json, skipping dependency install');
    return;
  }

  const pm = detectPackageManager(target);
  logger.info({ repo, packageManager: pm }, 'Installing dependencies');

  const result = execSafe(`${pm} install`, { cwd: target });
  if (result.ok) {
    logger.info({ repo }, 'Dependencies installed');
  } else {
    logger.warn(
      { repo, stderr: result.stderr },
      'Dependency install failed — continuing',
    );
  }
}

/**
 * Create the `setup workspace` subcommand.
 */
export function setupWorkspaceCommand(): Command {
  const command = new Command('workspace');

  command
    .description('Clone repositories and install dependencies')
    .option(
      '--repos <repos>',
      'Comma-separated list of repos to clone (or REPOS env)',
    )
    .option(
      '--branch <branch>',
      'Target branch (or REPO_BRANCH/DEFAULT_BRANCH env)',
    )
    .option('--workdir <dir>', 'Workspace root directory', '/workspaces')
    .option('--clean', 'Hard reset repos before updating (or CLEAN_REPOS env)')
    .action(async (options) => {
      const logger = getLogger();
      const config = resolveWorkspaceConfig(options);

      logger.info('Setting up workspace');
      logger.info(
        { org: config.githubOrg, branch: config.branch, repos: config.repos.length },
        'Configuration',
      );

      // Step 1: Setup
      mkdirSync(config.workdir, { recursive: true });
      exec("git config --global --add safe.directory '*'");

      // Step 2: Ensure git credentials
      ensureGitCredentials();

      // Step 3: Clone/update repos
      let successCount = 0;
      let failureCount = 0;
      const processedRepos: string[] = [];

      // Process tetrad-development first if in the list
      const orderedRepos = [...config.repos];
      const tetradIndex = orderedRepos.indexOf('tetrad-development');
      if (tetradIndex > 0) {
        orderedRepos.splice(tetradIndex, 1);
        orderedRepos.unshift('tetrad-development');
      }

      for (const repo of orderedRepos) {
        if (cloneOrUpdateRepo(repo, config)) {
          successCount++;
          processedRepos.push(repo);
        } else {
          failureCount++;
        }
      }

      // Step 4: Install dependencies
      for (const repo of processedRepos) {
        installDeps(repo, config.workdir);
      }

      // Step 5: Report summary
      logger.info(
        { success: successCount, failed: failureCount, total: orderedRepos.length },
        'Workspace setup complete',
      );

      if (failureCount > 0) {
        logger.error(
          { failures: failureCount },
          'Some repos failed to clone — re-run `generacy setup workspace` to retry',
        );
        process.exit(1);
      }
    });

  return command;
}
