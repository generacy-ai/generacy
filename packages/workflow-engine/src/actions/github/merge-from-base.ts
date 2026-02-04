/**
 * github.merge_from_base action - merges from base branch with conflict detection.
 * Fetches latest changes and merges, reporting any conflicts.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  MergeFromBaseInput,
  MergeFromBaseOutput,
  ConflictInfo,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.merge_from_base action handler
 */
export class MergeFromBaseAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.merge_from_base';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.merge_from_base' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const abortOnConflict = this.getInput<boolean>(step, context, 'abort_on_conflict', false);
    const autoResolve = this.getInput<boolean>(step, context, 'auto_resolve', true);
    const parentEpicNumber = this.getInput<number>(step, context, 'parent_epic_number');

    context.logger.info('Merging from base branch');

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Check for uncommitted changes first
      const status = await client.getStatus();
      let stashCreated = false;

      if (status.has_changes) {
        // Stash changes before merge
        stashCreated = await client.stash('autodev: pre-merge stash');
        context.logger.info('Stashed uncommitted changes');
      }

      // Fetch latest from remote
      await client.fetch('origin', true);

      // Determine base branch
      let baseBranch: string;
      let mergedFromEpic = false;

      if (parentEpicNumber) {
        // Try to find epic branch
        const epicBranch = `${parentEpicNumber}-`;
        const currentBranch = await client.getCurrentBranch();
        // Epic branches would be like: epic/123-feature or 123-feature
        baseBranch = `origin/${epicBranch}`;
        // Check if exists, otherwise fall back to default
        const exists = await client.branchExists(epicBranch, true);
        if (!exists) {
          baseBranch = `origin/${await client.getDefaultBranch()}`;
        } else {
          mergedFromEpic = true;
        }
      } else {
        // Use default branch
        const defaultBranch = await client.getDefaultBranch();
        baseBranch = `origin/${defaultBranch}`;
      }

      context.logger.info(`Merging from ${baseBranch}`);

      // Perform merge
      const mergeResult = await client.merge(baseBranch);

      // Handle conflicts
      let conflictsRemaining: ConflictInfo[] = [];
      let conflictsResolved = 0;

      if (!mergeResult.success && mergeResult.conflicts.length > 0) {
        if (abortOnConflict) {
          // Abort merge and restore stash
          await client.mergeAbort();
          if (stashCreated) {
            await client.stashPop();
          }
          return this.failureResult(
            `Merge conflict detected in ${mergeResult.conflicts.length} file(s). Aborted.`,
            {
              output: {
                success: false,
                base_branch: baseBranch,
                merged_from_epic: mergedFromEpic,
                commits_merged: 0,
                already_up_to_date: false,
                conflicts_resolved: 0,
                conflicts_remaining: mergeResult.conflicts,
                stash_created: stashCreated,
                summary: `Merge aborted due to ${mergeResult.conflicts.length} conflict(s)`,
              } as MergeFromBaseOutput,
            }
          );
        }

        // Return conflicts for agent resolution
        conflictsRemaining = mergeResult.conflicts;
      }

      // Restore stash if created
      if (stashCreated) {
        const stashResult = await client.stashPop();
        if (!stashResult.success && stashResult.conflicts) {
          context.logger.warn('Stash pop resulted in conflicts');
        }
      }

      const output: MergeFromBaseOutput = {
        success: mergeResult.success || conflictsRemaining.length === 0,
        base_branch: baseBranch.replace('origin/', ''),
        merged_from_epic: mergedFromEpic,
        commits_merged: mergeResult.commits_merged,
        already_up_to_date: mergeResult.already_up_to_date,
        conflicts_resolved: conflictsResolved,
        conflicts_remaining: conflictsRemaining,
        stash_created: stashCreated,
        summary: mergeResult.summary,
      };

      if (conflictsRemaining.length > 0) {
        return this.failureResult(
          `Merge completed with ${conflictsRemaining.length} conflict(s) requiring resolution`,
          { output }
        );
      }

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
