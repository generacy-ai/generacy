/**
 * `generacy cockpit` command group.
 *
 * Three single-issue verbs that inspect and drive workflow state for one issue:
 *   - state           — classify one issue and print its curated cockpit tier
 *   - advance         — manually advance a waiting gate (flip waiting-for → completed)
 *   - clarify-context — gather JSON context for the open clarification request
 */
import { Command } from 'commander';
import { stateCommand } from './state.js';
import { advanceCommand } from './advance.js';
import { clarifyContextCommand } from './clarify-context.js';

export function cockpitCommand(): Command {
  const command = new Command('cockpit');
  command.description('Cockpit — inspect and drive workflow state for one issue.');

  command.addCommand(stateCommand());
  command.addCommand(advanceCommand());
  command.addCommand(clarifyContextCommand());

  return command;
}
