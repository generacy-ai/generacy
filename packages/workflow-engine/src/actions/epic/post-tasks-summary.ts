/**
 * epic.post_tasks_summary action - posts task summary for epic review.
 */
import { BaseAction } from '../base-action.js';
import type {
  ActionContext,
  ActionResult,
  ActionIdentifier,
  StepDefinition,
  PostTasksSummaryInput,
  PostTasksSummaryOutput,
} from '../../types/index.js';
import { isNamespacedAction } from '../../types/action.js';
import type { GitHubClient } from '../github/client/index.js';
import { createGitHubClient } from '../github/client/index.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * epic.post_tasks_summary action handler
 */
export class PostTasksSummaryAction extends BaseAction {
  readonly type: ActionIdentifier = 'epic.post_tasks_summary';

  canHandle(step: StepDefinition): boolean {
    const uses = step.uses ?? step.action;
    if (!uses) return false;
    return uses === 'epic.post_tasks_summary' ||
           (isNamespacedAction(uses) && uses === this.type);
  }

  protected async executeInternal(
    step: StepDefinition,
    context: ActionContext
  ): Promise<Omit<ActionResult, 'duration'>> {
    // Get inputs
    const issueNumber = this.getRequiredInput<number>(step, context, 'issue_number');
    const featureDir = this.getInput<string>(step, context, 'feature_dir');
    const groupingStrategy = this.getInput<string>(step, context, 'grouping_strategy', 'per-task');

    context.logger.info(`Posting tasks summary for issue #${issueNumber}`);

    try {
      // Get GitHub client
      const client: GitHubClient = createGitHubClient(context.workdir);

      // Get repo info
      const repoInfo = await client.getRepoInfo();

      // Find feature directory
      const specsDir = join(context.workdir, 'specs');
      let targetDir = featureDir;
      if (!targetDir) {
        const dirs = readdirSync(specsDir);
        const found = dirs.find(d => d.startsWith(`${issueNumber}-`));
        if (!found) {
          return this.failureResult(`No spec directory found for issue #${issueNumber}`);
        }
        targetDir = join(specsDir, found);
      }

      // Read tasks.md
      const tasksPath = join(targetDir, 'tasks.md');
      if (!existsSync(tasksPath)) {
        return this.failureResult(`tasks.md not found in ${targetDir}`);
      }

      const tasksContent = readFileSync(tasksPath, 'utf-8');

      // Parse and summarize tasks
      const summary = this.generateTasksSummary(tasksContent, groupingStrategy as 'per-task' | 'per-story' | 'per-phase');

      // Post comment
      const commentBody = `<!-- tasks-summary -->\n## Tasks Summary\n\n${summary}`;
      const comment = await client.addIssueComment(
        repoInfo.owner,
        repoInfo.repo,
        issueNumber,
        commentBody
      );

      // Count tasks
      const taskCount = (tasksContent.match(/- \[ \]/g) || []).length +
                       (tasksContent.match(/- \[x\]/gi) || []).length;

      const output: PostTasksSummaryOutput = {
        comment_id: comment.id,
        comment_url: `https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues/${issueNumber}#issuecomment-${comment.id}`,
        task_count: taskCount,
        grouping_used: groupingStrategy ?? 'per-task',
      };

      context.logger.info(`Posted tasks summary with ${taskCount} tasks`);

      return this.successResult(output);
    } catch (error) {
      return this.failureResult(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Generate tasks summary based on grouping strategy
   */
  private generateTasksSummary(
    tasks: string,
    grouping: 'per-task' | 'per-story' | 'per-phase'
  ): string {
    // Parse task lines
    const taskLines = tasks.split('\n')
      .filter(line => line.match(/^- \[[ x]\]/i));

    if (grouping === 'per-task') {
      // Simple list
      return taskLines.map(line => {
        const completed = line.includes('[x]') || line.includes('[X]');
        const status = completed ? '' : '';
        return `${status} ${line.replace(/^- \[[ x]\]\s*/i, '')}`;
      }).join('\n');
    }

    if (grouping === 'per-phase') {
      // Group by phase headers in the markdown
      const phases: Record<string, string[]> = {};
      let currentPhase = 'Other';

      for (const line of tasks.split('\n')) {
        if (line.startsWith('## Phase')) {
          currentPhase = line.replace('## ', '');
        } else if (line.match(/^- \[[ x]\]/i)) {
          if (!phases[currentPhase]) {
            phases[currentPhase] = [];
          }
          const completed = line.includes('[x]') || line.includes('[X]');
          const status = completed ? '' : '';
          phases[currentPhase]!.push(`${status} ${line.replace(/^- \[[ x]\]\s*/i, '')}`);
        }
      }

      return Object.entries(phases)
        .map(([phase, items]) => `### ${phase}\n${items.join('\n')}`)
        .join('\n\n');
    }

    // per-story: Group by user story markers
    const stories: Record<string, string[]> = {};
    for (const line of taskLines) {
      const storyMatch = line.match(/\[US\d+\]/);
      const story = storyMatch ? storyMatch[0] : 'Other';
      if (!stories[story]) {
        stories[story] = [];
      }
      const completed = line.includes('[x]') || line.includes('[X]');
      const status = completed ? '' : '';
      stories[story]!.push(`${status} ${line.replace(/^- \[[ x]\]\s*/i, '').replace(/\[US\d+\]\s*/, '')}`);
    }

    return Object.entries(stories)
      .map(([story, items]) => `### ${story}\n${items.join('\n')}`)
      .join('\n\n');
  }
}
