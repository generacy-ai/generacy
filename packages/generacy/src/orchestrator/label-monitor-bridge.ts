/**
 * Bridge adapter that connects the LabelMonitorService (from @generacy-ai/orchestrator)
 * to the simple orchestrator's job queue.
 *
 * Implements the QueueAdapter interface expected by LabelMonitorService,
 * converting QueueItem → Job and submitting via the orchestrator server.
 * Fetches issue details from GitHub to populate workflow inputs.
 */
import type { QueueAdapter, QueueItem } from '@generacy-ai/orchestrator';
import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type { OrchestratorServer } from './server.js';
import type { JobPriority } from './types.js';

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export class LabelMonitorBridge implements QueueAdapter {
  constructor(
    private readonly server: OrchestratorServer,
    private readonly createGitHubClient: GitHubClientFactory,
    private readonly logger: Logger,
  ) {}

  async enqueue(item: QueueItem): Promise<void> {
    const priority: JobPriority = 'high';
    const issueUrl = `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`;

    // Fetch issue details to populate workflow inputs (e.g. description)
    let description = `Issue #${item.issueNumber} from ${item.owner}/${item.repo}`;
    try {
      const github = this.createGitHubClient();
      const issue = await github.getIssue(item.owner, item.repo, item.issueNumber);
      description = issue.body || issue.title;
    } catch (error) {
      this.logger.warn('Failed to fetch issue details, using fallback description', {
        owner: item.owner,
        repo: item.repo,
        issueNumber: item.issueNumber,
        error: String(error),
      });
    }

    const jobId = await this.server.submitJob({
      name: `${item.command}:${item.owner}/${item.repo}#${item.issueNumber}`,
      priority,
      workflow: item.workflowName,
      inputs: {
        description,
        owner: item.owner,
        repo: item.repo,
        issue_number: item.issueNumber,
        issue_url: issueUrl,
        command: item.command,
      },
      tags: ['label-monitor', item.command, `${item.owner}/${item.repo}`],
      metadata: {
        source: 'label-monitor',
        enqueuedAt: item.enqueuedAt,
        workflowName: item.workflowName,
      },
    });

    this.logger.info('Label monitor job submitted', {
      jobId,
      owner: item.owner,
      repo: item.repo,
      issueNumber: item.issueNumber,
      command: item.command,
      workflowName: item.workflowName,
    });
  }
}
