/**
 * github.read_pr_feedback action - gets unresolved PR comments.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  ReadPRFeedbackInput,
  ReadPRFeedbackOutput,
  Comment,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.read_pr_feedback action handler
 */
export class ReadPRFeedbackAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.read_pr_feedback';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.read_pr_feedback' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const prNumber = this.getRequiredInput<number>(step, context, 'pr_number');
    const includeResolved = this.getInput<boolean>(step, context, 'include_resolved', false);

    context.logger.info(`Reading feedback for PR #${prNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Get PR comments
      const allComments = await client.getPRComments(repoInfo.owner, repoInfo.repo, prNumber);

      // Filter based on resolved status
      let comments: Comment[];
      if (includeResolved) {
        comments = allComments;
      } else {
        comments = allComments.filter(c => c.resolved !== true);
      }

      const unresolvedCount = comments.filter(c => c.resolved === false).length;

      const output: ReadPRFeedbackOutput = {
        comments,
        has_unresolved: unresolvedCount > 0,
        unresolved_count: unresolvedCount,
      };

      context.logger.info(`Found ${comments.length} comments (${unresolvedCount} unresolved)`);

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
