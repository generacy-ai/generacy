/**
 * Epic Completion Monitor Service
 *
 * Polls for epic issues with `waiting-for:children-complete` label and checks
 * whether all child issues have completed. When all children are done, it
 * removes the waiting label and adds `completed:children-complete`, which
 * triggers the LabelMonitorService to enqueue an `epic-complete` command.
 *
 * Status comments are updated on each poll cycle using the `<!-- epic-status -->`
 * HTML marker pattern.
 */
import type { GitHubClientFactory, GitHubClient } from '@generacy-ai/workflow-engine';
import { findChildIssues } from '@generacy-ai/workflow-engine';
import type { EpicChildWithPr } from '@generacy-ai/workflow-engine';
import type { RepositoryConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Logger interface (matches existing service patterns)
// ---------------------------------------------------------------------------

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EpicMonitorConfig {
  enabled: boolean;
  pollIntervalMs: number; // default: 300000 (5 min)
}

type EpicChild = EpicChildWithPr;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WAITING_LABEL = 'waiting-for:children-complete';
const COMPLETED_LABEL = 'completed:children-complete';
const STATUS_MARKER = '<!-- epic-status -->';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Monitors epic issues for child completion. Runs as a standalone polling loop
 * alongside the LabelMonitorService.
 */
export class EpicCompletionMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly config: EpicMonitorConfig;
  private readonly repositories: RepositoryConfig[];
  private abortController: AbortController | null = null;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    config: EpicMonitorConfig,
    repositories: RepositoryConfig[],
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.config = config;
    this.repositories = repositories;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async startPolling(): Promise<void> {
    if (this.abortController) {
      this.logger.warn('Epic completion monitor polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.logger.info(
      { intervalMs: this.config.pollIntervalMs, repos: this.repositories.length },
      'Starting epic completion monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during epic completion poll cycle',
        );
      }

      await this.sleep(this.config.pollIntervalMs, ac.signal);
    }

    this.logger.info('Epic completion monitor polling stopped');
  }

  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('Epic completion monitor stop requested');
    }
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  /**
   * Run a single poll cycle across all watched repositories.
   */
  async poll(): Promise<void> {
    for (const { owner, repo } of this.repositories) {
      try {
        await this.pollRepo(owner, repo);
      } catch (error) {
        this.logger.error(
          { err: error, owner, repo },
          'Error polling repository for epic completion',
        );
      }
    }
  }

  /**
   * Poll a single repository for epics waiting on children.
   */
  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient();

    // Find all issues with the waiting-for:children-complete label
    const epics = await client.listIssuesWithLabel(owner, repo, WAITING_LABEL);
    if (epics.length === 0) return;

    this.logger.info(
      { owner, repo, count: epics.length },
      'Found epics waiting for children',
    );

    for (const epic of epics) {
      try {
        await this.checkEpic(client, owner, repo, epic.number);
      } catch (error) {
        this.logger.error(
          { err: error, owner, repo, issueNumber: epic.number },
          'Error checking epic completion',
        );
      }
    }
  }

  // ==========================================================================
  // Epic Completion Check
  // ==========================================================================

  /**
   * Check a single epic's child completion status, update the progress
   * comment, and transition labels if all children are complete.
   */
  private async checkEpic(
    client: GitHubClient,
    owner: string,
    repo: string,
    epicNumber: number,
  ): Promise<void> {
    // Find child issues
    const children = await this.findChildIssues(owner, repo, epicNumber);

    if (children.length === 0) {
      this.logger.warn(
        { owner, repo, epicNumber },
        'Epic has no children found — skipping',
      );
      return;
    }

    // Calculate completion stats
    const totalChildren = children.length;
    const completedChildren = children.filter(
      c => c.state === 'closed' && c.pr_merged,
    ).length;
    const percentage = Math.round((completedChildren / totalChildren) * 100);

    this.logger.info(
      { owner, repo, epicNumber, percentage, completedChildren, totalChildren },
      `Epic #${epicNumber} progress: ${percentage}%`,
    );

    // Update status comment
    await this.updateStatusComment(
      client,
      owner,
      repo,
      epicNumber,
      percentage,
      totalChildren,
      completedChildren,
      children,
    );

    // Check if all children are complete
    if (completedChildren === totalChildren) {
      this.logger.info(
        { owner, repo, epicNumber },
        'All children complete — transitioning epic',
      );

      // Remove waiting label, add completed label
      await client.removeLabels(owner, repo, epicNumber, [WAITING_LABEL]);
      await client.addLabels(owner, repo, epicNumber, [COMPLETED_LABEL]);

      // The LabelMonitorService will detect `completed:children-complete`
      // paired with the now-removed `waiting-for:children-complete` and
      // enqueue an `epic-complete` command. No direct enqueue needed here.
    }
  }

  // ==========================================================================
  // Child Issue Discovery (delegates to shared utility)
  // ==========================================================================

  /**
   * Find child issues that reference the given epic via `epic-parent: #N` in
   * their body. Delegates to the shared `findChildIssues` utility from
   * `@generacy-ai/workflow-engine`.
   */
  private async findChildIssues(
    owner: string,
    repo: string,
    epicNumber: number,
  ): Promise<EpicChild[]> {
    return findChildIssues(owner, repo, epicNumber, {
      state: 'all',
      includePrStatus: true,
    });
  }

  // ==========================================================================
  // Status Comment
  // ==========================================================================

  /**
   * Create or update the `<!-- epic-status -->` progress comment on the epic.
   */
  private async updateStatusComment(
    client: GitHubClient,
    owner: string,
    repo: string,
    epicNumber: number,
    percentage: number,
    total: number,
    completed: number,
    children: EpicChild[],
  ): Promise<void> {
    const body = this.generateStatusComment(
      percentage, total, completed, children,
    );

    // Find existing status comment
    const comments = await client.getIssueComments(owner, repo, epicNumber);
    const existing = comments.find(c => c.body.includes(STATUS_MARKER));

    if (existing) {
      await client.updateComment(owner, repo, existing.id, body);
    } else {
      await client.addIssueComment(owner, repo, epicNumber, body);
    }
  }

  /**
   * Generate the markdown body for the epic status comment.
   */
  private generateStatusComment(
    percentage: number,
    total: number,
    completed: number,
    children: EpicChild[],
  ): string {
    const filled = Math.round(percentage / 10);
    const empty = 10 - filled;
    const progressBar = `${'█'.repeat(filled)}${'░'.repeat(empty)}`;

    let body = `${STATUS_MARKER}\n## Epic Progress\n\n`;
    body += `| Child | Status | PR |\n`;
    body += `|-------|--------|----|`;

    for (const child of children) {
      const status = child.state === 'closed' && child.pr_merged
        ? ':white_check_mark: Merged'
        : child.labels.some(l => l.startsWith('waiting-for:'))
          ? ':hourglass: Blocked'
          : child.labels.includes('agent:in-progress')
            ? ':hourglass: In progress'
            : child.state === 'closed'
              ? ':white_check_mark: Closed'
              : ':clock1: Pending';

      const prLink = child.pr_number ? `#${child.pr_number}` : '—';
      body += `\n| #${child.issue_number} ${child.title} | ${status} | ${prLink} |`;
    }

    body += `\n\n**Progress**: ${progressBar} ${percentage}% (${completed}/${total} complete)`;
    body += `\n**Last checked**: ${new Date().toISOString()}`;

    return body;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
