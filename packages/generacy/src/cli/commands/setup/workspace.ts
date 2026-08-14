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
import { tryLoadWorkspaceConfig, getRepoNames, parseRepoList, scanForWorkspaceConfig } from '@generacy-ai/config';

/**
 * Which tier of the resolution chain supplied `branch`. `'none'` means no tier
 * did: setup has no opinion and must leave checkouts on whatever branch they
 * are already on.
 */
type BranchSource =
  | 'CLI flag'
  | 'REPO_BRANCH env'
  | 'DEFAULT_BRANCH env'
  | 'config file'
  | 'none';

/**
 * Workspace configuration resolved from CLI args and environment variables.
 */
interface WorkspaceConfig {
  repos: string[];
  branch: string | undefined;
  branchSource: BranchSource;
  workdir: string;
  clean: boolean;
  githubOrg: string;
  repoSource: 'CLI flag' | 'REPOS env var' | 'config file';
}

/**
 * CLI options as parsed by Commander (repos is a comma-separated string).
 */
interface WorkspaceCliOptions {
  repos?: string;
  branch?: string;
  workdir?: string;
  clean?: boolean;
  config?: string;
}

/**
 * Resolve workspace config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveWorkspaceConfig(cliArgs: WorkspaceCliOptions): WorkspaceConfig {
  const logger = getLogger();
  const envRepos = process.env['REPOS'];
  const cliRepos = cliArgs.repos;
  const workdir = cliArgs.workdir ?? '/workspaces';

  let repos: string[];
  let repoSource: WorkspaceConfig['repoSource'];
  let configOrg: string | undefined;
  let configBranch: string | undefined;

  if (cliRepos) {
    const parsed = parseRepoList(cliRepos, process.env['GITHUB_ORG'] ?? 'generacy-ai');
    repos = parsed.map((r) => r.repo);
    if (!configOrg && parsed.length > 0) configOrg = parsed[0]!.owner;
    repoSource = 'CLI flag';
  } else if (envRepos) {
    const parsed = parseRepoList(envRepos, process.env['GITHUB_ORG'] ?? 'generacy-ai');
    repos = parsed.map((r) => r.repo);
    if (!configOrg && parsed.length > 0) configOrg = parsed[0]!.owner;
    repoSource = 'REPOS env var';
  } else {
    // Try explicit config path: --config flag or CONFIG_PATH env var
    const explicitConfigPath = cliArgs.config ?? process.env['CONFIG_PATH'];
    let wsConfig = explicitConfigPath ? tryLoadWorkspaceConfig(explicitConfigPath) : null;

    if (!wsConfig && explicitConfigPath) {
      logger.error(
        { path: explicitConfigPath },
        'Config file not found or invalid at specified path',
      );
      return process.exit(1) as never;
    }

    // Fallback: scan workdir subdirectories for config
    if (!wsConfig) {
      const foundPaths = scanForWorkspaceConfig(workdir);

      if (foundPaths.length > 1) {
        logger.error(
          { configs: foundPaths },
          'Multiple .generacy/config.yaml files found. Use --config or CONFIG_PATH to specify which one.',
        );
        return process.exit(1) as never;
      }

      if (foundPaths.length === 1) {
        wsConfig = tryLoadWorkspaceConfig(foundPaths[0]!);
      }
    }

    if (wsConfig) {
      repos = getRepoNames(wsConfig);
      configOrg = wsConfig.org;
      configBranch = wsConfig.branch;
      repoSource = 'config file';
    } else {
      logger.error(
        'No .generacy/config.yaml found. Provide one via --config, CONFIG_PATH env, ' +
        'or ensure a project with .generacy/config.yaml is mounted under ' + workdir,
      );
      return process.exit(1) as never;
    }
  }

  logger.info({ source: repoSource, count: repos.length }, 'Resolved repos');

  const branchTiers: Array<[string | undefined, BranchSource]> = [
    [cliArgs.branch, 'CLI flag'],
    [process.env['REPO_BRANCH'], 'REPO_BRANCH env'],
    [process.env['DEFAULT_BRANCH'], 'DEFAULT_BRANCH env'],
    [configBranch, 'config file'],
  ];
  const resolvedTier = branchTiers.find(([value]) => value !== undefined);
  const branch = resolvedTier?.[0];
  const branchSource: BranchSource = resolvedTier?.[1] ?? 'none';

  const cleanEnv = process.env['CLEAN_REPOS'];
  const clean = cliArgs.clean ?? (cleanEnv === 'true');

  return {
    repos,
    branch,
    branchSource,
    workdir,
    clean,
    githubOrg: process.env['GITHUB_ORG'] ?? configOrg ?? 'generacy-ai',
    repoSource,
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
 * Update an existing checkout when no branch preference was resolved.
 * Never switches branches — setup must not move a checkout it has no opinion
 * about. Non-standard states (detached HEAD, no matching remote branch) are
 * fetched and left alone, and still count as success.
 */
function updateRepoWithoutBranchPreference(repo: string, target: string): boolean {
  const logger = getLogger();

  const currentBranch = execSafe('git branch --show-current', { cwd: target });
  const branch = currentBranch.ok ? currentBranch.stdout : '';

  if (!branch) {
    logger.warn(
      { repo },
      'Detached HEAD and no branch configured — fetched only, leaving checkout as-is',
    );
    return true;
  }

  const remoteBranch = execSafe(
    `git rev-parse --verify --quiet refs/remotes/origin/${branch}`,
    { cwd: target },
  );
  if (!remoteBranch.ok) {
    logger.warn(
      { repo, branch },
      'Current branch has no matching origin branch — fetched only, leaving checkout as-is',
    );
    return true;
  }

  execSafe(`git pull origin ${branch}`, { cwd: target });
  return true;
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

    if (config.branch === undefined) {
      return updateRepoWithoutBranchPreference(repo, target);
    }

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
  logger.info(
    { repo, branch: config.branch ?? '(repo default)' },
    'Cloning repository',
  );

  const cloneUrl = `https://github.com/${config.githubOrg}/${repo}.git`;

  if (config.branch !== undefined) {
    // Try clone with specified branch
    const clone = execSafe(
      `git clone --branch ${config.branch} ${cloneUrl} ${target}`,
    );
    if (clone.ok) {
      logger.info({ repo }, 'Repository cloned successfully');
      return true;
    }

    logger.info({ repo }, 'Branch not found, cloning default branch');
  }

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
      'Comma-separated repos: bare names, owner/repo, or GitHub URLs (or REPOS env)',
    )
    .option(
      '--branch <branch>',
      'Target branch (or REPO_BRANCH/DEFAULT_BRANCH env)',
    )
    .option('--workdir <dir>', 'Workspace root directory', '/workspaces')
    .option('--config <path>', 'Path to .generacy/config.yaml (or CONFIG_PATH env)')
    .option('--clean', 'Hard reset repos before updating (or CLEAN_REPOS env)')
    .action(async (options) => {
      const logger = getLogger();
      const config = resolveWorkspaceConfig(options);

      logger.info('Setting up workspace');
      logger.info(
        {
          org: config.githubOrg,
          branch: config.branch ?? '(repo default / current branch)',
          branchSource: config.branchSource,
          repos: config.repos.length,
          source: config.repoSource,
        },
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

      for (const repo of config.repos) {
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
        { success: successCount, failed: failureCount, total: processedRepos.length + failureCount },
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
