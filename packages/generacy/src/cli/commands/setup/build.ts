/**
 * Setup build subcommand.
 * Cleans stale Claude plugin state, builds Agency and Generacy packages.
 * Replaces .devcontainer/setup-plugins.sh
 */
import { Command } from 'commander';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '../../utils/logger.js';
import { exec, execSafe } from '../../utils/exec.js';

/**
 * Build configuration resolved from CLI args.
 */
interface BuildConfig {
  skipCleanup: boolean;
  skipAgency: boolean;
  skipGeneracy: boolean;
  agencyDir: string;
  generacyDir: string;
  latencyDir: string;
  latestPlugin: boolean;
}

/**
 * Resolve build config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveBuildConfig(cliArgs: Partial<BuildConfig> & { latest?: boolean }): BuildConfig {
  return {
    skipCleanup: cliArgs.skipCleanup ?? false,
    skipAgency: cliArgs.skipAgency ?? false,
    skipGeneracy: cliArgs.skipGeneracy ?? false,
    agencyDir: cliArgs.agencyDir ?? '/workspaces/agency',
    generacyDir: cliArgs.generacyDir ?? '/workspaces/generacy',
    latencyDir: cliArgs.latencyDir ?? '/workspaces/latency',
    latestPlugin: cliArgs.latestPlugin ?? cliArgs.latest ?? false,
  };
}

/**
 * Check whether we're running in an external project (no source repos present).
 * External projects use installed packages instead of building from source.
 */
function isExternalProject(config: BuildConfig): boolean {
  return !existsSync(config.agencyDir) && !existsSync(config.latencyDir);
}

/**
 * Phase 1: Clean stale Claude plugin state.
 * Removes marketplace caches, resets installed plugins, and clears enabledPlugins from settings.
 * All operations are non-fatal — errors are logged as warnings.
 */
function cleanPluginState(): void {
  const logger = getLogger();
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const pluginsDir = join(claudeDir, 'plugins');

  logger.info('Phase 1: Cleaning stale Claude plugin state');

  // Remove marketplace cache directories
  const dirsToRemove = [
    join(pluginsDir, 'cache', 'painworth-marketplace'),
    join(pluginsDir, 'marketplaces', 'painworth-marketplace'),
  ];

  for (const dir of dirsToRemove) {
    try {
      rmSync(dir, { recursive: true, force: true });
      logger.debug({ path: dir }, 'Removed directory');
    } catch (error) {
      logger.warn({ path: dir, error: String(error) }, 'Failed to remove directory');
    }
  }

  // Reset installed_plugins.json
  try {
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: {} }),
    );
    logger.debug('Reset installed_plugins.json');
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to reset installed_plugins.json');
  }

  // Remove known_marketplaces.json and install-counts-cache.json
  const filesToRemove = [
    join(pluginsDir, 'known_marketplaces.json'),
    join(pluginsDir, 'install-counts-cache.json'),
  ];

  for (const file of filesToRemove) {
    try {
      rmSync(file, { force: true });
      logger.debug({ path: file }, 'Removed file');
    } catch (error) {
      logger.warn({ path: file, error: String(error) }, 'Failed to remove file');
    }
  }

  // Remove enabledPlugins from settings.json
  const settingsPath = join(claudeDir, 'settings.json');
  try {
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      delete settings['enabledPlugins'];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      logger.debug('Removed enabledPlugins from settings.json');
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to update settings.json');
  }

  logger.info('Phase 1 complete: Plugin state cleaned');
}

/**
 * Phase 2: Build Agency packages.
 * Builds latency first, then agency. Creates .agency/config.json and verifies artifacts.
 */
function buildAgency(config: BuildConfig): void {
  const logger = getLogger();

  logger.info('Phase 2: Building Agency packages');

  if (!existsSync(config.agencyDir)) {
    logger.info('Skipping source build for agency/latency — using installed packages');
    return;
  }

  // Build latency first
  if (existsSync(config.latencyDir)) {
    logger.info('Building latency dependency');
    exec('pnpm install --no-frozen-lockfile', { cwd: config.latencyDir });
    exec('pnpm build', { cwd: config.latencyDir });
    logger.info('Latency built successfully');
  } else {
    logger.warn({ dir: config.latencyDir }, 'Latency directory not found, skipping');
  }

  // Install and build agency
  logger.info('Installing agency dependencies');
  exec('pnpm install --no-frozen-lockfile', { cwd: config.agencyDir });
  logger.info('Building agency');
  exec('pnpm build', { cwd: config.agencyDir });

  // Create .agency/config.json if it doesn't exist
  const agencyConfigDir = join(config.agencyDir, '.agency');
  const agencyConfigPath = join(agencyConfigDir, 'config.json');
  if (!existsSync(agencyConfigPath)) {
    logger.info('Creating .agency/config.json');
    mkdirSync(agencyConfigDir, { recursive: true });
    writeFileSync(
      agencyConfigPath,
      JSON.stringify(
        {
          name: 'agency',
          pluginPaths: [join(config.agencyDir, 'packages')],
          defaultMode: 'coding',
          modes: { coding: ['*'], research: ['*'], default: ['*'] },
        },
        null,
        2,
      ),
    );
  } else {
    logger.debug('.agency/config.json already exists');
  }

  // Verify artifacts
  const agencyCli = join(config.agencyDir, 'packages', 'agency', 'dist', 'cli.js');
  const specKitPlugin = join(
    config.agencyDir,
    'packages',
    'agency-plugin-spec-kit',
    'dist',
    'index.js',
  );

  if (!existsSync(agencyCli)) {
    logger.error({ path: agencyCli }, 'Agency CLI artifact missing after build');
    process.exit(1);
  }
  if (!existsSync(specKitPlugin)) {
    logger.error({ path: specKitPlugin }, 'Spec-kit plugin artifact missing after build');
    process.exit(1);
  }

  logger.info('Phase 2 complete: Agency built and verified');
}

/**
 * Phase 3: Build Generacy packages.
 * Installs deps (excluding claude-code plugin), builds, links globally, and verifies artifacts.
 */
function buildGeneracy(config: BuildConfig): void {
  const logger = getLogger();

  logger.info('Phase 3: Building Generacy packages');

  if (!existsSync(config.generacyDir)) {
    logger.info('Skipping source build for generacy — using installed packages');
    return;
  }

  // Install deps with filter exclusion for claude-code plugin
  // Hardcoded workaround: this plugin has build issues in the dev container
  logger.info('Installing generacy dependencies');
  exec(
    'pnpm install --filter "!@generacy-ai/generacy-plugin-claude-code"',
    { cwd: config.generacyDir },
  );

  // Build
  logger.info('Building generacy');
  exec('pnpm build', { cwd: config.generacyDir });

  // Link globally
  logger.info('Linking generacy CLI globally');
  exec('npm link', { cwd: join(config.generacyDir, 'packages', 'generacy') });

  // Verify artifact
  const cliArtifact = join(
    config.generacyDir,
    'packages',
    'generacy',
    'dist',
    'cli',
    'index.js',
  );
  if (!existsSync(cliArtifact)) {
    logger.error({ path: cliArtifact }, 'Generacy CLI artifact missing after build');
    process.exit(1);
  }

  logger.info('Phase 3 complete: Generacy built and verified');
}

/**
 * Speckit command files that may exist as old file-copy artifacts in ~/.claude/commands/.
 */
const SPECKIT_COMMAND_FILES = [
  'specify.md',
  'clarify.md',
  'plan.md',
  'tasks.md',
  'implement.md',
  'checklist.md',
  'analyze.md',
  'constitution.md',
  'taskstoissues.md',
];

/**
 * Resolve the npm global root directory (where globally installed packages live).
 * Returns the trimmed path on success, or null if `npm root -g` fails.
 */
function resolveNpmGlobalRoot(): string | null {
  const result = execSafe('npm root -g');
  if (result.ok && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}

/**
 * Phase 4: Install speckit commands and configure Agency MCP for Claude Code.
 * Installs speckit slash commands via marketplace plugin with fallback to file copy.
 * Adds the Agency MCP server to the user-level Claude config.
 */
function installClaudeCodeIntegration(config: BuildConfig): void {
  const logger = getLogger();
  const home = homedir();
  const claudeDir = join(home, '.claude');

  logger.info('Phase 4: Installing Claude Code integration (speckit commands + Agency MCP)');

  // Step 1: Add marketplace via CLI (idempotent — skips if already registered)
  let marketplaceRegistered = false;
  const marketplaceList = execSafe('claude plugin marketplace list');
  const alreadyRegistered = marketplaceList.ok && marketplaceList.stdout?.includes('generacy-marketplace');

  if (alreadyRegistered) {
    marketplaceRegistered = true;
    logger.info('generacy-marketplace already registered');
  } else {
    // Use local directory if agency source is available, otherwise clone from GitHub
    let addResult;
    if (existsSync(join(config.agencyDir, '.claude-plugin', 'marketplace.json'))) {
      addResult = execSafe(`claude plugin marketplace add ${config.agencyDir} --scope user`);
    } else {
      addResult = execSafe('claude plugin marketplace add generacy-ai/agency --scope user --sparse packages/claude-plugin-agency-spec-kit .claude-plugin');
    }

    if (addResult.ok) {
      marketplaceRegistered = true;
      logger.info('Registered generacy-marketplace');
    } else {
      logger.warn({ stderr: addResult.stderr }, 'Failed to register generacy-marketplace');
    }
  }

  // Step 2: Install plugin from marketplace
  let pluginInstalled = false;
  if (marketplaceRegistered) {
    const installCmd = 'claude plugin install agency-spec-kit@generacy-marketplace --scope user';
    const result = execSafe(installCmd);
    if (result.ok) {
      pluginInstalled = true;
      logger.info('Installed agency-spec-kit plugin via marketplace');
    } else {
      logger.warn({ stderr: result.stderr }, 'Marketplace plugin install failed, trying fallback');
    }
  }

  // Step 3: Fallback to file copy from agency repo (only when agency dir exists)
  if (!pluginInstalled && existsSync(config.agencyDir)) {
    const pluginCommandsDir = join(
      config.agencyDir,
      'packages',
      'claude-plugin-agency-spec-kit',
      'commands',
    );
    const userCommandsDir = join(home, '.claude', 'commands');

    if (existsSync(pluginCommandsDir)) {
      mkdirSync(userCommandsDir, { recursive: true });
      const files = readdirSync(pluginCommandsDir).filter((f) => f.endsWith('.md'));
      for (const file of files) {
        copyFileSync(join(pluginCommandsDir, file), join(userCommandsDir, file));
      }
      logger.info(
        { count: files.length, dest: userCommandsDir },
        'Fallback: copied speckit command definitions',
      );
    } else {
      logger.warn(
        { dir: pluginCommandsDir },
        'Speckit commands directory not found and marketplace install failed',
      );
    }
  } else if (!pluginInstalled) {
    // Step 3b: Fallback to npm global @generacy-ai/agency/commands/
    let npmFallbackCopied = false;
    const globalRoot = resolveNpmGlobalRoot();
    if (globalRoot) {
      const npmCommandsDir = join(globalRoot, '@generacy-ai', 'agency', 'commands');
      if (existsSync(npmCommandsDir)) {
        const userCommandsDir = join(home, '.claude', 'commands');
        mkdirSync(userCommandsDir, { recursive: true });
        const files = readdirSync(npmCommandsDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          copyFileSync(join(npmCommandsDir, file), join(userCommandsDir, file));
        }
        if (files.length > 0) {
          npmFallbackCopied = true;
          logger.info(
            { count: files.length, dest: userCommandsDir },
            'Copied speckit command definitions from npm global',
          );
        }
      }
    }
    if (!npmFallbackCopied) {
      logger.warn('No speckit commands available — marketplace, source, and npm fallbacks all failed');
    }
  } else {
    // Step 4: Clean up old file-copy commands to avoid duplicates
    const userCommandsDir = join(home, '.claude', 'commands');
    let cleanedCount = 0;
    for (const file of SPECKIT_COMMAND_FILES) {
      const filePath = join(userCommandsDir, file);
      if (existsSync(filePath)) {
        try {
          rmSync(filePath, { force: true });
          cleanedCount++;
        } catch {
          // Ignore cleanup errors for individual files
        }
      }
    }
    if (cleanedCount > 0) {
      logger.info({ count: cleanedCount }, 'Cleaned up old file-copy commands');
    }
  }

  // Step 5: Add Agency MCP server to user-level Claude config (~/.claude.json)
  const claudeJsonPath = join(home, '.claude.json');
  const sourceAgencyCli = join(config.agencyDir, 'packages', 'agency', 'dist', 'cli.js');

  // Resolve agency CLI: prefer source build, fall back to globally installed package
  let agencyCli: string | null = null;
  let agencyCwd: string | undefined;

  if (existsSync(sourceAgencyCli)) {
    agencyCli = sourceAgencyCli;
    agencyCwd = config.agencyDir;
  } else {
    // Find globally installed @generacy-ai/agency package
    const globalRoot = resolveNpmGlobalRoot();
    if (globalRoot) {
      const globalCliPath = join(globalRoot, '@generacy-ai', 'agency', 'dist', 'cli.js');
      if (existsSync(globalCliPath)) {
        agencyCli = globalCliPath;
        logger.info({ path: agencyCli }, 'Using globally installed agency CLI');
      }
    }
  }

  if (!agencyCli) {
    logger.info('Skipping MCP configuration — agency CLI not found');
    logger.info('Phase 4 complete: Claude Code integration installed');
    return;
  }

  try {
    let claudeJson: Record<string, unknown> = {};
    if (existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    }

    const mcpServers = (claudeJson['mcpServers'] ?? {}) as Record<string, unknown>;
    const mcpEntry: Record<string, unknown> = {
      type: 'stdio',
      command: 'node',
      args: [agencyCli],
    };
    if (agencyCwd) {
      mcpEntry['cwd'] = agencyCwd;
    }
    mcpServers['agency'] = mcpEntry;
    claudeJson['mcpServers'] = mcpServers;

    writeFileSync(claudeJsonPath, JSON.stringify(claudeJson, null, 2));
    logger.info('Configured Agency MCP server in user-level Claude config');
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to configure Agency MCP server');
  }

  logger.info('Phase 4 complete: Claude Code integration installed');
}

/**
 * Create the `setup build` subcommand.
 */
export function setupBuildCommand(): Command {
  const command = new Command('build');

  command
    .description('Clean plugins, build Agency and Generacy packages')
    .option('--skip-cleanup', 'Skip Phase 1: Claude plugin state cleanup')
    .option('--skip-agency', 'Skip Phase 2: Agency package build')
    .option('--skip-generacy', 'Skip Phase 3: Generacy package build')
    .option('--latest', 'Install latest plugin version instead of pinned version')
    .action(async (options) => {
      const logger = getLogger();
      const config = resolveBuildConfig(options);

      logger.info('Starting build process');

      // Phase 1: Clean stale Claude plugin state
      if (!config.skipCleanup) {
        cleanPluginState();
      } else {
        logger.info('Skipping Phase 1: Plugin cleanup (--skip-cleanup)');
      }

      // Phase 2: Build Agency packages
      if (!config.skipAgency) {
        buildAgency(config);
      } else {
        logger.info('Skipping Phase 2: Agency build (--skip-agency)');
      }

      // Phase 3: Build Generacy packages
      if (!config.skipGeneracy) {
        buildGeneracy(config);
      } else {
        logger.info('Skipping Phase 3: Generacy build (--skip-generacy)');
      }

      // Phase 4: Install Claude Code integration (speckit commands + Agency MCP)
      if (!config.skipAgency) {
        installClaudeCodeIntegration(config);
      } else {
        logger.info('Skipping Phase 4: Claude Code integration (--skip-agency)');
      }

      logger.info('Build process complete');
    });

  return command;
}
