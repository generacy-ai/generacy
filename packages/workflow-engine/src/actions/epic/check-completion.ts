/**
 * epic.check_completion action - checks child issue completion status.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  CheckCompletionInput,
  CheckCompletionOutput,
  EpicChild,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';
import { executeCommand } from '../cli-utils.js';

/**
 * epic.check_completion action handler
 */
export class CheckCompletionAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.check_completion';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.check_completion' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const epicIssueNumber = this.getRequiredInput<number>(step, context, 'epic_issue_number');

    context.logger.info(`Checking completion status for epic #${epicIssueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Search for child issues that reference this epic
      const children = await this.findChildIssues(repoInfo.owner, repoInfo.repo, epicIssueNumber);

      // Calculate completion stats
      const totalChildren = children.length;
      const completedChildren = children.filter(c => c.state === 'closed' && c.pr_merged).length;
      const inProgressChildren = children.filter(c => c.state === 'open' && c.labels.includes('agent:in-progress')).length;
      const blockedChildren = children.filter(c => c.labels.some(l => l.startsWith('waiting-for:'))).length;

      const percentage = totalChildren > 0
        ? Math.round((completedChildren / totalChildren) * 100)
        : 0;

      const readyForPr = totalChildren > 0 && completedChildren === totalChildren;

      const output: CheckCompletionOutput = {
        percentage,
        ready_for_pr: readyForPr,
        total_children: totalChildren,
        completed_children: completedChildren,
        in_progress_children: inProgressChildren,
        blocked_children: blockedChildren,
        children,
      };

      context.logger.info(`Epic ${percentage}% complete (${completedChildren}/${totalChildren})`);

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Find child issues that reference the epic
   */
  private async findChildIssues(
    owner: string,
    repo: string,
    epicNumber: number
  ): Promise<EpicChild[]> {
    // Use gh CLI to search for issues that mention this epic in their body
    const result = await executeCommand('gh', [
      'issue', 'list',
      '-R', `${owner}/${repo}`,
      '--search', `"epic-parent: ${epicNumber}" in:body`,
      '--json', 'number,title,state,labels',
      '--limit', '100',
    ]);

    if (result.exitCode !== 0) {
      return [];
    }

    try {
      const issues = JSON.parse(result.stdout) as Array<{
        number: number;
        title: string;
        state: string;
        labels: Array<{ name: string }>;
      }>;

      // For each child, check if PR was merged
      const children: EpicChild[] = [];
      for (const issue of issues) {
        // Check for merged PR
        const prResult = await executeCommand('gh', [
          'pr', 'list',
          '-R', `${owner}/${repo}`,
          '--search', `closes:#${issue.number}`,
          '--state', 'merged',
          '--json', 'number',
          '--limit', '1',
        ]);

        const prMerged = prResult.exitCode === 0 &&
                        prResult.stdout.trim() !== '[]';

        children.push({
          issue_number: issue.number,
          title: issue.title,
          state: issue.state.toLowerCase() as 'open' | 'closed',
          pr_merged: prMerged,
          labels: issue.labels.map(l => l.name),
        });
      }

      return children;
    } catch {
      return [];
    }
  }
}
