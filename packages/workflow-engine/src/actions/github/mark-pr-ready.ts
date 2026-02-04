/**
 * github.mark_pr_ready action - converts a draft PR to ready for review.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  MarkPRReadyInput,
  MarkPRReadyOutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.mark_pr_ready action handler
 */
export class MarkPRReadyAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.mark_pr_ready';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.mark_pr_ready' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const prNumber = this.getRequiredInput<number>(step, context, 'pr_number');

    context.logger.info(`Marking PR #${prNumber} as ready for review`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Mark PR as ready
      await client.markPRReady(repoInfo.owner, repoInfo.repo, prNumber);

      context.logger.info(`PR #${prNumber} is now ready for review`);

      const output: MarkPRReadyOutput = {
        success: true,
        pr_number: prNumber,
        pr_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
