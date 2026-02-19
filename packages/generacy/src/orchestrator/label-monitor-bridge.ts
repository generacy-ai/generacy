/**
 * Bridge adapter that connects the LabelMonitorService (from @generacy-ai/orchestrator)
 * to the simple orchestrator's job queue.
 *
 * Implements the QueueAdapter interface expected by LabelMonitorService,
 * converting QueueItem → Job and submitting via the orchestrator server.
 */
import type { QueueAdapter, QueueItem } from '@generacy-ai/orchestrator';
import type { OrchestratorServer } from './server.js';
import type { JobPriority } from './types.js';

interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
}

export class LabelMonitorBridge implements QueueAdapter {
  constructor(
    private readonly server: OrchestratorServer,
    private readonly logger: Logger,
  ) {}

  async enqueue(item: QueueItem): Promise<void> {
    const priority: JobPriority = 'high';

    const jobId = await this.server.submitJob({
      name: `${item.command}:${item.owner}/${item.repo}#${item.issueNumber}`,
      priority,
      workflow: item.workflowName,
      inputs: {
        owner: item.owner,
        repo: item.repo,
        issueNumber: item.issueNumber,
        command: item.command,
        issueUrl: `https://github.com/${item.owner}/${item.repo}/issues/${item.issueNumber}`,
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
