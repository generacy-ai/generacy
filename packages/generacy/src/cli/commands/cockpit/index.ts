import { Command } from 'commander';
import { watchCommand } from './watch.js';
import { statusCommand } from './status.js';

export function cockpitCommand(): Command {
  return new Command('cockpit')
    .description('Read-only observability for Generacy epics and repos.')
    .addCommand(watchCommand())
    .addCommand(statusCommand());
}
