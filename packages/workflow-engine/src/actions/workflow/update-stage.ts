/**
 * workflow.update_stage action - updates stage comment with progress.
 * Creates or updates consolidated stage comments on issues.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  UpdateStageInput,
  UpdateStageOutput,
  StageProgress,
  WorkflowStage,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';

/**
 * Stage comment markers
 */
const STAGE_MARKERS: Record<WorkflowStage, string> = {
  specification: '<!-- stage:specification -->',
  planning: '<!-- stage:planning -->',
  implementation: '<!-- stage:implementation -->',
};

/**
 * Stage titles
 */
const STAGE_TITLES: Record<WorkflowStage, string> = {
  specification: 'Specification',
  planning: 'Planning',
  implementation: 'Implementation',
};

/**
 * Status icons
 */
const STATUS_ICONS: Record<string, string> = {
  pending: '',
  in_progress: '',
  complete: '',
  blocked: '',
};

/**
 * workflow.update_stage action handler
 */
export class UpdateStageAction extends BaseAction {
  readonly type: ActionIdentifier = 'workflow.update_stage';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'workflow.update_stage' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const stage = this.getRequiredInput<WorkflowStage>(step, context, 'stage');
    const status = this.getRequiredInput<string>(step, context, 'status');
    const progress = this.getRequiredInput<StageProgress[]>(step, context, 'progress');
    const branch = this.getInput<string>(step, context, 'branch');
    const prNumber = this.getInput<number>(step, context, 'pr_number');
    const nextStep = this.getInput<string>(step, context, 'next_step');
    const blockedReason = this.getInput<string>(step, context, 'blocked_reason');

    context.logger.info(`Updating stage comment: ${stage} (${status}) for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Generate comment body
      const commentBody = this.generateStageComment(
        stage,
        status as 'in_progress' | 'complete' | 'blocked',
        progress,
        branch,
        prNumber,
        nextStep,
        blockedReason
      );

      // Find existing stage comment
      const comments = await client.getIssueComments(repoInfo.owner, repoInfo.repo, issueNumber);
      const marker = STAGE_MARKERS[stage];
      const existingComment = comments.find(c => c.body.includes(marker));

      let commentId: number;
      let created: boolean;

      if (existingComment) {
        // Update existing comment
        await client.updateComment(
          repoInfo.owner,
          repoInfo.repo,
          existingComment.id,
          commentBody
        );
        commentId = existingComment.id;
        created = false;
        context.logger.info(`Updated existing stage comment ${commentId}`);
      } else {
        // Create new comment
        const comment = await client.addIssueComment(
          repoInfo.owner,
          repoInfo.repo,
          issueNumber,
          commentBody
        );
        commentId = comment.id;
        created = true;
        context.logger.info(`Created new stage comment ${commentId}`);
      }

      const output: UpdateStageOutput = {
        success: true,
        comment_id: commentId,
        comment_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${issueNumber}#issuecomment-${commentId}`,
        created,
      };

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate stage comment body
   */
  private generateStageComment(
    stage: WorkflowStage,
    status: 'in_progress' | 'complete' | 'blocked',
    progress: StageProgress[],
    branch?: string,
    prNumber?: number,
    nextStep?: string,
    blockedReason?: string
  ): string {
    const marker = STAGE_MARKERS[stage];
    const title = STAGE_TITLES[stage];
    const statusIcon = STATUS_ICONS[status];

    let body = `${marker}\n## ${statusIcon} ${title}\n\n`;

    // Add branch and PR info
    if (branch) {
      body += `**Branch:** \`${branch}\`\n`;
    }
    if (prNumber) {
      body += `**PR:** #${prNumber}\n`;
    }
    if (branch || prNumber) {
      body += '\n';
    }

    // Add progress items
    body += '### Progress\n\n';
    for (const item of progress) {
      const icon = STATUS_ICONS[item.status];
      const statusText = item.status === 'complete' ? 'Done' :
                        item.status === 'in_progress' ? 'In Progress' : 'Pending';
      body += `- ${icon} **${item.command}**: ${statusText}`;
      if (item.summary) {
        body += ` - ${item.summary}`;
      }
      body += '\n';
    }

    // Add next step or blocked reason
    if (status === 'blocked' && blockedReason) {
      body += `\n**Blocked:** ${blockedReason}\n`;
    } else if (nextStep) {
      body += `\n**Next:** ${nextStep}\n`;
    }

    // Add timestamp
    body += `\n---\n*Updated: ${new Date().toISOString()}*\n`;

    return body;
  }
}
