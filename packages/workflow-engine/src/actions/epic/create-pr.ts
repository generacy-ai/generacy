/**
 * epic.create_pr action - creates rollup PR from epic branch.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CreateEpicPRInput,
  CreateEpicPROutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';
import { CheckCompletionAction } from './check-completion.js';

/**
 * epic.create_pr action handler
 */
export class CreateEpicPRAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.create_pr';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.create_pr' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const epicIssueNumber = this.getRequiredInput<number>(step, context, 'epic_issue_number');
    const customTitle = this.getInput<string>(step, context, 'title');
    const skipApprovalLabel = this.getInput<boolean>(step, context, 'skip_approval_label', false);

    context.logger.info(`Creating rollup PR for epic #${epicIssueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Check completion status
      const checkAction = new CheckCompletionAction();
      const checkResult = await checkAction.execute(
        {
          ...step,
          with: { epic_issue_number: epicIssueNumber },
        },
        context
      );

      if (!checkResult.success) {
        return this.failureResult(`Failed to check completion: ${checkResult.error}`);
      }

      const status = checkResult.output as {
        percentage: number;
        ready_for_pr: boolean;
        completed_children: number;
      };

      if (!status.ready_for_pr) {
        return this.failureResult(
          `Epic is not ready for PR (${status.percentage}% complete). All children must be completed.`
        );
      }

      // Get epic issue for title
      const epicIssue = await client.getIssue(repoInfo.owner, repoInfo.repo, epicIssueNumber);
      const title = customTitle ?? `[Epic] ${epicIssue.title}`;

      // Determine epic branch name
      const epicBranch = `${epicIssueNumber}-`;
      const branches = await client.listBranches(repoInfo.owner, repoInfo.repo);
      const matchingBranch = branches.find(b => b.startsWith(epicBranch));

      if (!matchingBranch) {
        return this.failureResult(`Could not find epic branch starting with ${epicBranch}`);
      }

      // Determine base branch (develop if exists, otherwise main/master)
      let baseBranch = repoInfo.default_branch;
      if (branches.includes('develop')) {
        baseBranch = 'develop';
      }

      // Count commits that will be included
      const commitsIncluded = await this.countCommits(client, matchingBranch, baseBranch);

      // Generate PR body
      const body = this.generatePRBody(epicIssueNumber, status.completed_children);

      // Check if PR already exists
      const existingPR = await client.getPRForBranch(
        repoInfo.owner,
        repoInfo.repo,
        matchingBranch
      );

      let prNumber: number;
      let prUrl: string;

      if (existingPR) {
        // Update existing PR
        await client.updatePR(repoInfo.owner, repoInfo.repo, existingPR.number, {
          title,
          body,
        });
        prNumber = existingPR.number;
        prUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`;
        context.logger.info(`Updated existing PR #${prNumber}`);
      } else {
        // Create new PR
        const pr = await client.createPR(repoInfo.owner, repoInfo.repo, {
          title,
          body,
          head: matchingBranch,
          base: baseBranch,
          draft: false,
        });
        prNumber = pr.number;
        prUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}/pull/${prNumber}`;
        context.logger.info(`Created PR #${prNumber}`);
      }

      // Add approval label if not skipped
      if (!skipApprovalLabel) {
        await client.addLabels(repoInfo.owner, repoInfo.repo, prNumber, ['needs:epic-approval']);
        context.logger.info('Added needs:epic-approval label');
      }

      const output: CreateEpicPROutput = {
        pr_number: prNumber,
        pr_url: prUrl,
        commits_included: commitsIncluded,
        children_merged: status.completed_children,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Count commits between branches
   */
  private async countCommits(
    client: GitHubClient,
    headBranch: string,
    baseBranch: string
  ): Promise<number> {
    try {
      // Use git rev-list to count commits
      const { execSync } = await import('child_process');
      const result = execSync(
        `git rev-list --count ${baseBranch}..${headBranch}`,
        { encoding: 'utf-8' }
      ).trim();
      return parseInt(result, 10) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Generate PR body for epic rollup
   */
  private generatePRBody(epicNumber: number, childrenMerged: number): string {
    let body = `## Epic Rollup PR\n\n`;
    body += `Closes #${epicNumber}\n\n`;
    body += `### Summary\n\n`;
    body += `This PR merges all completed work from epic #${epicNumber}.\n\n`;
    body += `**Children merged:** ${childrenMerged}\n\n`;
    body += `### Checklist\n\n`;
    body += `- [ ] All child issues are closed with merged PRs\n`;
    body += `- [ ] Integration tests pass\n`;
    body += `- [ ] Documentation is updated\n`;
    body += `- [ ] Ready for final review\n\n`;
    body += `---\n`;
    body += `*Created by Generacy workflow engine*\n`;

    return body;
  }
}
