/**
 * epic.close action - closes epic issue after PR merge.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CloseEpicInput,
  CloseEpicOutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';

/**
 * epic.close action handler
 */
export class CloseEpicAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.close';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.close' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const epicIssueNumber = this.getRequiredInput<number>(step, context, 'epic_issue_number');
    const prNumber = this.getInput<number>(step, context, 'pr_number');

    context.logger.info(`Closing epic #${epicIssueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // If PR number not provided, try to find it
      let mergedPR = prNumber;
      if (!mergedPR) {
        // Look for epic branch PR
        const epicBranch = `${epicIssueNumber}-`;
        const branches = await client.listBranches(repoInfo.owner, repoInfo.repo);
        const matchingBranch = branches.find(b => b.startsWith(epicBranch));

        if (matchingBranch) {
          const pr = await client.getPRForBranch(
            repoInfo.owner,
            repoInfo.repo,
            matchingBranch
          );
          if (pr && pr.state === 'merged') {
            mergedPR = pr.number;
          }
        }
      }

      // Generate completion comment
      const commentBody = this.generateCompletionComment(epicIssueNumber, mergedPR);

      // Add completion comment
      await client.addIssueComment(
        repoInfo.owner,
        repoInfo.repo,
        epicIssueNumber,
        commentBody
      );

      // Close the issue
      await client.updateIssue(repoInfo.owner, repoInfo.repo, epicIssueNumber, {
        state: 'closed',
      });

      context.logger.info(`Closed epic #${epicIssueNumber}`);

      const output: CloseEpicOutput = {
        closed: true,
        issue_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${epicIssueNumber}`,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate completion comment for epic
   */
  private generateCompletionComment(epicNumber: number, prNumber?: number): string {
    let body = `## ✅ Epic Completed\n\n`;
    body += `This epic has been successfully completed and closed.\n\n`;

    if (prNumber) {
      body += `**Merged via:** #${prNumber}\n\n`;
    }

    body += `---\n`;
    body += `*Closed by Generacy workflow engine at ${new Date().toISOString()}*\n`;

    return body;
  }
}
