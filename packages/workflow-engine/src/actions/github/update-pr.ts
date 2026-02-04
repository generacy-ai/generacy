/**
 * github.update_pr action - updates PR description with phase status.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  UpdatePRInput,
  UpdatePROutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.update_pr action handler
 */
export class UpdatePRAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.update_pr';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.update_pr' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getInput<number>(step, context, 'issue_number');
    const prNumberInput = this.getInput<number>(step, context, 'pr_number');
    const title = this.getInput<string>(step, context, 'title');
    const body = this.getInput<string>(step, context, 'body');

    context.logger.info('Updating PR');

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info and current branch
      const repoInfo = await client.getRepoInfo();
      const currentBranch = await client.getCurrentBranch();

      // Find PR number if not provided
      let prNumber = prNumberInput;
      if (!prNumber) {
        const pr = await client.findPRForBranch(repoInfo.owner, repoInfo.repo, currentBranch);
        if (!pr) {
          return this.failureResult('No PR found for current branch');
        }
        prNumber = pr.number;
      }

      // Update PR
      const updates: { title?: string; body?: string } = {};
      if (title) updates.title = title;
      if (body) updates.body = body;

      if (Object.keys(updates).length > 0) {
        await client.updatePullRequest(repoInfo.owner, repoInfo.repo, prNumber, updates);
        context.logger.info(`Updated PR #${prNumber}`);
      }

      const output: UpdatePROutput = {
        pr_number: prNumber,
        pr_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`,
        updated: Object.keys(updates).length > 0,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
