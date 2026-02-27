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
import { createLogger, setLogger } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';

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
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      const logger = createLogger({
        level: opts['logLevel'] as LogLevel,
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

  return program;
}

/**
 * Run the CLI with given arguments
 */
export async function run(args: string[] = process.argv): Promise<void> {
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
