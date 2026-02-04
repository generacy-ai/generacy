/**
 * github.review_changes action - reviews uncommitted changes.
 * Lists modified, added, deleted, and untracked files.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  ReviewChangesInput,
  ReviewChangesOutput,
  FileChange,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.review_changes action handler
 */
export class ReviewChangesAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.review_changes';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.review_changes' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const includeUntracked = this.getInput<boolean>(step, context, 'include_untracked', true);

    context.logger.info('Reviewing pending changes');

    try {
      // Get GitHub client for git operations
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get git status
      const status = await client.getStatus();

      const files: FileChange[] = [];

      // Add staged files
      for (const file of status.staged) {
        files.push({
          path: file,
          status: 'modified', // Simplified - could be added/modified/deleted
          staged: true,
        });
      }

      // Add unstaged files
      for (const file of status.unstaged) {
        // Check if already added as staged
        const existing = files.find(f => f.path === file);
        if (existing) {
          // File has both staged and unstaged changes
          continue;
        }
        files.push({
          path: file,
          status: 'modified',
          staged: false,
        });
      }

      // Add untracked files if requested
      if (includeUntracked) {
        for (const file of status.untracked) {
          files.push({
            path: file,
            status: 'untracked',
            staged: false,
          });
        }
      }

      // Build summary
      const summary = this.buildSummary(status, includeUntracked ?? true);

      const output: ReviewChangesOutput = {
        has_changes: status.has_changes,
        files,
        summary,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Build a human-readable summary of changes
   */
  private buildSummary(
    status: { staged: string[]; unstaged: string[]; untracked: string[]; has_changes: boolean },
    includeUntracked: boolean
  ): string {
    if (!status.has_changes) {
      return 'No uncommitted changes';
    }

    const parts: string[] = [];

    if (status.staged.length > 0) {
      parts.push(`${status.staged.length} staged`);
    }
    if (status.unstaged.length > 0) {
      parts.push(`${status.unstaged.length} modified`);
    }
    if (includeUntracked && status.untracked.length > 0) {
      parts.push(`${status.untracked.length} untracked`);
    }

    return `Changes: ${parts.join(', ')}`;
  }
}
