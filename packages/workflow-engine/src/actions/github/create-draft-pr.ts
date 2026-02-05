/**
 * github.create_draft_pr action - creates a draft PR linked to an issue.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CreateDraftPRInput,
  CreateDraftPROutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from './client/index.js';
import { createGitHubClient } from './client/index.js';

/**
 * github.create_draft_pr action handler
 */
export class CreateDraftPRAction extends BaseAction {
  readonly type: ActionIdentifier = 'github.create_draft_pr';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'github.create_draft_pr' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const title = this.getRequiredInput<string>(step, context, 'title');
    const body = this.getInput<string>(step, context, 'body');
    const baseBranch = this.getInput<string>(step, context, 'base_branch');

    context.logger.info(`Creating draft PR for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info and current branch
      const repoInfo = await client.getRepoInfo();
      const currentBranch = await client.getCurrentBranch();

      // Determine base branch
      const base = baseBranch ?? await client.getDefaultBranch();

      // Format PR body with issue link
      const prBody = body ?? this.generatePRBody(issueNumber);

      // Create the PR
      const pr = await client.createPullRequest(repoInfo.owner, repoInfo.repo, {
        title,
        body: prBody,
        head: currentBranch,
        base,
        draft: true,
      });

      context.logger.info(`Created draft PR #${pr.number}`);

      const output: CreateDraftPROutput = {
        pr_number: pr.number,
        pr_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${pr.number}`,
        state: 'draft',
        head_branch: currentBranch,
        base_branch: base,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate default PR body with issue reference
   */
  private generatePRBody(issueNumber: number): string {
    return `## Summary

Closes #${issueNumber}

## Changes

<!-- Describe the changes -->

## Test Plan

<!-- How to test these changes -->
`;
  }
}
