import { Command } from 'commander';
import { showCommand } from './show.js';
import { setCommand } from './set.js';

export function appConfigCommand(): Command {
  const cmd = new Command('app-config');

  cmd.description('Manage application configuration (env vars and files)');

  cmd.addCommand(showCommand());
  cmd.addCommand(setCommand());

  return cmd;
}
