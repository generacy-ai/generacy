/**
 * Parent setup command group.
 * Composes dev container setup subcommands: auth, workspace, build, services.
 */
import { Command } from 'commander';
import { setupAuthCommand } from './setup/auth.js';
import { setupWorkspaceCommand } from './setup/workspace.js';
import { setupBuildCommand } from './setup/build.js';
import { setupServicesCommand } from './setup/services.js';

export function setupCommand(): Command {
  const command = new Command('setup');
  command.description('Dev container setup commands');
  command.addCommand(setupAuthCommand());
  command.addCommand(setupWorkspaceCommand());
  command.addCommand(setupBuildCommand());
  command.addCommand(setupServicesCommand());
  return command;
}
