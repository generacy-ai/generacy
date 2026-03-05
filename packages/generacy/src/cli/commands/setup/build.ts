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
import { exec } from '../../utils/exec.js';

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
}

/**
 * Resolve build config with three-tier priority: defaults → env vars → CLI args.
 */
function resolveBuildConfig(cliArgs: Partial<BuildConfig>): BuildConfig {
  return {
    skipCleanup: cliArgs.skipCleanup ?? false,
    skipAgency: cliArgs.skipAgency ?? false,
    skipGeneracy: cliArgs.skipGeneracy ?? false,
    agencyDir: cliArgs.agencyDir ?? '/workspaces/agency',
    generacyDir: cliArgs.generacyDir ?? '/workspaces/generacy',
    latencyDir: cliArgs.latencyDir ?? '/workspaces/latency',
  };
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
    logger.warn({ dir: config.agencyDir }, 'Agency directory not found, skipping');
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
    logger.warn({ dir: config.generacyDir }, 'Generacy directory not found, skipping');
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
 * Phase 4: Install speckit commands and configure Agency MCP for Claude Code.
 * Copies speckit slash command definitions to ~/.claude/commands/ and adds the
 * Agency MCP server to the user-level Claude config so that spec_kit tools and
 * /specify, /clarify, /plan, /tasks, /implement commands are available in all
 * Claude Code sessions (including worker containers).
 */
function installClaudeCodeIntegration(config: BuildConfig): void {
  const logger = getLogger();
  const home = homedir();

  logger.info('Phase 4: Installing Claude Code integration (speckit commands + Agency MCP)');

  // Copy speckit command definitions to ~/.claude/commands/
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
    logger.info({ count: files.length, dest: userCommandsDir }, 'Copied speckit command definitions');
  } else {
    logger.warn({ dir: pluginCommandsDir }, 'Speckit commands directory not found, skipping');
  }

  // Add Agency MCP server to user-level Claude config (~/.claude.json)
  const claudeJsonPath = join(home, '.claude.json');
  const agencyCli = join(config.agencyDir, 'packages', 'agency', 'dist', 'cli.js');

  if (!existsSync(agencyCli)) {
    logger.warn('Agency CLI not found, skipping MCP configuration');
    return;
  }

  try {
    let claudeJson: Record<string, unknown> = {};
    if (existsSync(claudeJsonPath)) {
      claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf-8')) as Record<string, unknown>;
    }

    const mcpServers = (claudeJson['mcpServers'] ?? {}) as Record<string, unknown>;
    mcpServers['agency'] = {
      type: 'stdio',
      command: 'node',
      args: [agencyCli],
      cwd: config.agencyDir,
    };
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
