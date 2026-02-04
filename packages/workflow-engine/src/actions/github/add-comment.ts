/**
 * github.add_comment action - adds a comment to an issue.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  AddCommentInput,
  AddCommentOutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.add_comment action handler
 */
export class AddCommentAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.add_comment';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.add_comment' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const body = this.getRequiredInput<string>(step, context, 'body');
    const phase = this.getInput<string>(step, context, 'phase');

    context.logger.info(`Adding comment to issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Add the comment
      const comment = await client.addIssueComment(
        repoInfo.owner,
        repoInfo.repo,
        issueNumber,
        body
      );

      context.logger.info(`Added comment ${comment.id}`);

      const output: AddCommentOutput = {
        comment_id: comment.id,
        comment_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${issueNumber}#issuecomment-${comment.id}`,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
