import { Command } from 'commander';
import { cockpitMergeCommand } from './merge.js';
import { cockpitReviewContextCommand } from './review-context.js';

export function cockpitCommand(): Command {
  const cmd = new Command('cockpit');
  cmd.description('Epic cockpit verbs (merge, review-context)');
  cmd.addCommand(cockpitMergeCommand());
  cmd.addCommand(cockpitReviewContextCommand());
  return cmd;
}
