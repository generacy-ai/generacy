/**
 * Validate command implementation.
 * Validates a .generacy/config.yaml file and reports errors.
 */
import { Command } from 'commander';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  loadConfig,
  findConfigFile,
  parseConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
  ConfigValidationError,
  type GeneracyConfig,
} from '../../config/index.js';
import { getLogger } from '../utils/logger.js';
import { readFileSync } from 'node:fs';

/**
 * Format validation errors for display
 */
function formatValidationErrors(error: unknown): string {
  if (error instanceof ConfigNotFoundError) {
    return `Config file not found. Searched in:\n${error.searchPath.map(p => `  - ${p}`).join('\n')}\n\nCreate a config file at: ${error.searchPath[0]}`;
  }

  if (error instanceof ConfigParseError) {
    return `Failed to parse YAML: ${error.filePath}\n\n${error.cause.message}`;
  }

  if (error instanceof ConfigSchemaError) {
    const errorMessages = error.errors.errors
      .map(err => {
        const path = err.path.length > 0 ? err.path.join('.') : 'root';
        return `  - ${path}: ${err.message}`;
      })
      .join('\n');

    return `Schema validation failed: ${error.filePath}\n\nValidation errors:\n${errorMessages}`;
  }

  if (error instanceof ConfigValidationError) {
    return `Semantic validation failed:\n\n${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Display config summary
 */
function displayConfigSummary(config: GeneracyConfig, configPath: string): void {
  const logger = getLogger();

  logger.info('✓ Configuration is valid');
  logger.info(`\nConfig file: ${configPath}\n`);

  logger.info('Project:');
  logger.info(`  ID: ${config.project.id}`);
  logger.info(`  Name: ${config.project.name}`);

  logger.info('\nRepositories:');
  logger.info(`  Primary: ${config.repos.primary}`);

  if (config.repos.dev && config.repos.dev.length > 0) {
    logger.info(`  Dev (${config.repos.dev.length}):`);
    config.repos.dev.forEach(repo => {
      logger.info(`    - ${repo}`);
    });
  }

  if (config.repos.clone && config.repos.clone.length > 0) {
    logger.info(`  Clone (${config.repos.clone.length}):`);
    config.repos.clone.forEach(repo => {
      logger.info(`    - ${repo}`);
    });
  }

  if (config.defaults) {
    logger.info('\nDefaults:');
    if (config.defaults.agent) {
      logger.info(`  Agent: ${config.defaults.agent}`);
    }
    if (config.defaults.baseBranch) {
      logger.info(`  Base Branch: ${config.defaults.baseBranch}`);
    }
  }

  if (config.orchestrator) {
    logger.info('\nOrchestrator:');
    if (config.orchestrator.pollIntervalMs !== undefined) {
      logger.info(`  Poll Interval: ${config.orchestrator.pollIntervalMs}ms`);
    }
    if (config.orchestrator.workerCount !== undefined) {
      logger.info(`  Worker Count: ${config.orchestrator.workerCount}`);
    }
  }
}

/**
 * Create the validate command
 */
export function validateCommand(): Command {
  const command = new Command('validate');

  command
    .description('Validate .generacy/config.yaml file')
    .argument('[config]', 'Path to config file (optional, will auto-discover if not provided)')
    .option('-q, --quiet', 'Only output errors (no success messages)')
    .option('--json', 'Output results as JSON')
    .action(async (configArg?: string, options?: {
      quiet?: boolean;
      json?: boolean;
    }) => {
      const logger = getLogger();
      const quiet = options?.quiet ?? false;
      const jsonOutput = options?.json ?? false;

      try {
        let config: GeneracyConfig;
        let configPath: string;

        if (configArg) {
          // Explicit path provided
          configPath = resolve(configArg);

          if (!existsSync(configPath)) {
            throw new ConfigNotFoundError(process.cwd(), [configPath]);
          }

          // Read and parse the file
          const content = readFileSync(configPath, 'utf-8');
          config = parseConfig(content);

          if (!quiet && !jsonOutput) {
            logger.info({ path: configPath }, 'Validating config file');
          }
        } else {
          // Auto-discover
          if (!quiet && !jsonOutput) {
            logger.info('Searching for config file...');
          }

          const discoveredPath = findConfigFile();
          if (!discoveredPath) {
            throw new ConfigNotFoundError(process.cwd(), []);
          }

          configPath = discoveredPath;

          if (!quiet && !jsonOutput) {
            logger.info({ path: configPath }, 'Found config file');
          }

          // Load and validate
          config = loadConfig();
        }

        // Output results
        if (jsonOutput) {
          const result = {
            valid: true,
            configPath,
            config,
          };
          console.log(JSON.stringify(result, null, 2));
        } else if (!quiet) {
          displayConfigSummary(config, configPath);
        } else {
          // Quiet mode - just indicate success
          console.log('✓ Valid');
        }

        process.exit(0);
      } catch (error) {
        // Handle validation errors
        if (jsonOutput) {
          const result = {
            valid: false,
            error: error instanceof Error ? error.message : String(error),
            errorType: error instanceof Error ? error.constructor.name : 'Unknown',
          };
          console.log(JSON.stringify(result, null, 2));
        } else {
          logger.error('Validation failed:\n');
          console.error(formatValidationErrors(error));
        }

        process.exit(1);
      }
    });

  return command;
}
