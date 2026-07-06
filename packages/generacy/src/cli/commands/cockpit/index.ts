/**
 * `generacy cockpit` command group.
 *
 * Observability verbs (read-only) for Generacy epics and repos:
 *   - watch           — poll an epic's issues/PRs and emit cockpit events on state changes
 *   - status          — render a grouped, colorized table of the epic's current state
 *
 * Single-issue verbs that inspect and drive workflow state for one issue:
 *   - state           — classify one issue and print its curated cockpit tier
 *   - advance         — manually advance a waiting gate (flip waiting-for → completed)
 *   - clarify-context — gather JSON context for the open clarification request
 *
 * Epic merge/review verbs:
 *   - merge           — merge a PR once its required checks are green
 *   - review-context  — gather JSON context (diff, failing checks) for a PR review
 */
import { Command } from 'commander';
import { watchCommand } from './watch.js';
import { statusCommand } from './status.js';
import { stateCommand } from './state.js';
import { advanceCommand } from './advance.js';
import { clarifyContextCommand } from './clarify-context.js';
import { cockpitMergeCommand } from './merge.js';
import { cockpitReviewContextCommand } from './review-context.js';
import { queueCommand } from './queue.js';

export function cockpitCommand(): Command {
  const command = new Command('cockpit');
  command.description('Cockpit — inspect and drive workflow state for Generacy epics and issues.');

  command.addCommand(watchCommand());
  command.addCommand(statusCommand());
  command.addCommand(stateCommand());
  command.addCommand(advanceCommand());
  command.addCommand(clarifyContextCommand());
  command.addCommand(cockpitMergeCommand());
  command.addCommand(cockpitReviewContextCommand());
  command.addCommand(queueCommand());

  return command;
}
