/**
 * `generacy cockpit` command group.
 *
 * Observability verbs (read-only) for Generacy epics and repos:
 *   - watch    — poll an epic's issues/PRs and emit cockpit events on state changes
 *   - status   — render a grouped, colorized table of the epic's current state
 *
 * Single-issue verbs that inspect and drive workflow state for one issue:
 *   - context  — classify the current waiting-for:* gate and emit its bundle
 *   - advance  — manually advance a waiting gate (flip waiting-for → completed)
 *
 * Epic merge/review verbs:
 *   - merge    — merge a PR once its required checks are green
 *   - queue    — enqueue eligible refs under a phase heading to the cluster pipeline
 */
import { Command } from 'commander';
import { watchCommand } from './watch.js';
import { statusCommand } from './status.js';
import { advanceCommand } from './advance.js';
import { contextCommand } from './context.js';
import { cockpitMergeCommand } from './merge.js';
import { queueCommand } from './queue.js';

export function cockpitCommand(): Command {
  const command = new Command('cockpit');
  command.description('Cockpit — inspect and drive workflow state for Generacy epics and issues.');

  command.addCommand(watchCommand());
  command.addCommand(statusCommand());
  command.addCommand(advanceCommand());
  command.addCommand(contextCommand());
  command.addCommand(cockpitMergeCommand());
  command.addCommand(queueCommand());

  return command;
}
