/**
 * github.respond_pr_feedback action - posts responses to PR comments.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  RespondPRFeedbackInput,
  RespondPRFeedbackOutput,
  FeedbackResponse,
  PostedResponse,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.respond_pr_feedback action handler
 */
export class RespondPRFeedbackAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.respond_pr_feedback';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.respond_pr_feedback' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const prNumber = this.getRequiredInput<number>(step, context, 'pr_number');
    const responses = this.getRequiredInput<FeedbackResponse[]>(step, context, 'responses');

    context.logger.info(`Responding to ${responses.length} comments on PR #${prNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      const posted: PostedResponse[] = [];
      const failed: number[] = [];

      // Post each response
      for (const response of responses) {
        try {
          const reply = await client.replyToPRComment(
            repoInfo.owner,
            repoInfo.repo,
            prNumber,
            response.comment_id,
            response.body
          );

          posted.push({
            comment_id: response.comment_id,
            reply_id: reply.id,
            success: true,
          });

          context.logger.info(`Posted reply to comment ${response.comment_id}`);
        } catch (error) {
          failed.push(response.comment_id);
          context.logger.warn(
            `Failed to reply to comment ${response.comment_id}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      const output: RespondPRFeedbackOutput = {
        posted,
        failed,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
