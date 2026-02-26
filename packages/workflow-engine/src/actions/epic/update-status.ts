/**
 * epic.update_status action - updates epic progress comment.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  UpdateStatusInput,
  UpdateStatusOutput,
  EpicChild,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';
import { CheckCompletionAction } from './check-completion.js';

/**
 * epic.update_status action handler
 */
export class UpdateStatusAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.update_status';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.update_status' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const epicIssueNumber = this.getRequiredInput<number>(step, context, 'epic_issue_number');
    const forceUpdate = this.getInput<boolean>(step, context, 'force_update', false);

    context.logger.info(`Updating status for epic #${epicIssueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Check completion status using the check-completion action
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
        total_children: number;
        completed_children: number;
        in_progress_children: number;
        blocked_children: number;
        children: EpicChild[];
      };

      // Generate status comment
      const commentBody = this.generateStatusComment(
        epicIssueNumber,
        status.percentage,
        status.total_children,
        status.completed_children,
        status.in_progress_children,
        status.blocked_children,
        status.children
      );

      // Find existing status comment
      const comments = await client.getIssueComments(repoInfo.owner, repoInfo.repo, epicIssueNumber);
      const marker = '<!-- epic-status -->';
      const existingComment = comments.find(c => c.body.includes(marker));

      let commentId: number;
      const updated = true;

      if (existingComment) {
        // Update existing comment
        await client.updateComment(
          repoInfo.owner,
          repoInfo.repo,
          existingComment.id,
          commentBody
        );
        commentId = existingComment.id;
        context.logger.info(`Updated existing status comment ${commentId}`);
      } else {
        // Create new comment
        const comment = await client.addIssueComment(
          repoInfo.owner,
          repoInfo.repo,
          epicIssueNumber,
          commentBody
        );
        commentId = comment.id;
        context.logger.info(`Created new status comment ${commentId}`);
      }

      const output: UpdateStatusOutput = {
        comment_id: commentId,
        comment_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${epicIssueNumber}#issuecomment-${commentId}`,
        updated,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate status comment body
   */
  private generateStatusComment(
    epicNumber: number,
    percentage: number,
    total: number,
    completed: number,
    inProgress: number,
    blocked: number,
    children: EpicChild[]
  ): string {
    const progressBar = this.generateProgressBar(percentage);

    let body = `<!-- epic-status -->\n## Epic Progress\n\n`;
    body += `${progressBar} **${percentage}%**\n\n`;
    body += `| Status | Count |\n|--------|-------|\n`;
    body += `|  Completed | ${completed} |\n`;
    body += `|  In Progress | ${inProgress} |\n`;
    body += `|  Blocked | ${blocked} |\n`;
    body += `| **Total** | **${total}** |\n\n`;

    // List children
    if (children.length > 0) {
      body += `### Child Issues\n\n`;
      for (const child of children) {
        const icon = child.state === 'closed' && child.pr_merged ? '' :
                    child.labels.some(l => l.startsWith('waiting-for:')) ? '' :
                    child.labels.includes('agent:in-progress') ? '' : '';
        body += `- ${icon} #${child.issue_number}: ${child.title}\n`;
      }
    }

    body += `\n---\n*Updated: ${new Date().toISOString()}*\n`;

    return body;
  }

  /**
   * Generate ASCII progress bar
   */
  private generateProgressBar(percentage: number): string {
    const filled = Math.round(percentage / 10);
    const empty = 10 - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }
}
