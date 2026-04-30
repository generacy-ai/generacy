/**
 * CLI entry point.
 * Sets up Commander.js program and registers subcommands.
 */
import { Command } from 'commander';
import { runCommand } from './commands/run.js';
import { workerCommand } from './commands/worker.js';
import { agentCommand } from './commands/agent.js';
import { orchestratorCommand } from './commands/orchestrator.js';
import { setupCommand } from './commands/setup.js';
import { validateCommand } from './commands/validate.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init/index.js';
import { claudeLoginCommand } from './commands/claude-login/index.js';
import { openCommand } from './commands/open/index.js';
import { launchCommand } from './commands/launch/index.js';
import { upCommand } from './commands/up/index.js';
import { stopCommand } from './commands/stop/index.js';
import { downCommand } from './commands/down/index.js';
import { destroyCommand } from './commands/destroy/index.js';
import { statusCommand } from './commands/status/index.js';
import { updateCommand } from './commands/update/index.js';
import { deployCommand } from './commands/deploy/index.js';
import { createLogger, setLogger } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { setupErrorHandlers } from './utils/error-handler.js';
import { placeholderCommands } from './commands/placeholders.js';

// Package version - will be replaced at build time
const VERSION = '0.0.1';

/**
 * Create and configure the CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('generacy')
    .description('Generacy CLI - Headless workflow execution engine')
    .version(VERSION)
    .option('-l, --log-level <level>', 'Log level (trace, debug, info, warn, error, fatal, silent)', 'info')
    .option('--no-pretty', 'Disable pretty logging (use JSON)')
    .option('-q, --quiet', 'Suppress all log output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      const logger = createLogger({
        level: opts['quiet'] ? 'silent' as LogLevel : opts['logLevel'] as LogLevel,
        pretty: opts['pretty'] !== false,
      });
      setLogger(logger);
    });

  // Register subcommands
  program.addCommand(runCommand());
  program.addCommand(workerCommand());
  program.addCommand(agentCommand());
  program.addCommand(orchestratorCommand());
  program.addCommand(setupCommand());
  program.addCommand(validateCommand());
  program.addCommand(doctorCommand());
  program.addCommand(initCommand());
  program.addCommand(claudeLoginCommand());
  program.addCommand(openCommand());
  program.addCommand(launchCommand());
  program.addCommand(upCommand());
  program.addCommand(stopCommand());
  program.addCommand(downCommand());
  program.addCommand(destroyCommand());
  program.addCommand(statusCommand());
  program.addCommand(updateCommand());
  program.addCommand(deployCommand());

  // Register v1.5 placeholder subcommands
  for (const cmd of placeholderCommands()) {
    program.addCommand(cmd);
  }

  return program;
}

/**
 * Run the CLI with given arguments
 */
export async function run(args: string[] = process.argv): Promise<void> {
  setupErrorHandlers();
  const program = createProgram();

  try {
    await program.parseAsync(args);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
      if (process.env['DEBUG']) {
        console.error(error.stack);
      }
    } else {
      console.error('An unknown error occurred');
    }
    process.exit(1);
  }
}
