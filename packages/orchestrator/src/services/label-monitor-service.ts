import { WORKFLOW_LABELS, type GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type {
  LabelEvent,
  MonitorState,
  QueueAdapter,
  PhaseTracker,
  QueueItem,
} from '../types/index.js';
import type { RepositoryConfig, MonitorConfig } from '../config/schema.js';
import { filterByAssignee } from './identity.js';

/**
 * Known process:* and completed:* label names derived from WORKFLOW_LABELS.
 * Using these avoids a GraphQL listLabels call on every poll cycle.
 */
const KNOWN_PROCESS_LABELS = WORKFLOW_LABELS
  .filter(l => l.name.startsWith('process:'))
  .map(l => l.name);

const KNOWN_COMPLETED_LABELS = WORKFLOW_LABELS
  .filter(l => l.name.startsWith('completed:'))
  .map(l => l.name);

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface LabelMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}

const PROCESS_LABEL_PREFIX = 'process:';
const COMPLETED_LABEL_PREFIX = 'completed:';
const WAITING_FOR_LABEL_PREFIX = 'waiting-for:';
const AGENT_IN_PROGRESS_LABEL = 'agent:in-progress';
const MIN_POLL_INTERVAL_MS = 10000;
const ADAPTIVE_DIVISOR = 3;

/**
 * Label monitor service that watches repositories for trigger labels
 * using a hybrid webhook + polling approach.
 */
export class LabelMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly phaseTracker: PhaseTracker;
  private readonly queueAdapter: QueueAdapter;
  private readonly options: LabelMonitorOptions;
  private readonly clusterGithubUsername: string | undefined;
  private abortController: AbortController | null = null;
  private pollCycleCount = 0;

  /**
   * How often to check completed:* labels (every Nth cycle).
   * Process:* labels are checked every cycle. Completed:* labels
   * are for resume detection and can be checked less frequently.
   */
  private static readonly COMPLETED_CHECK_INTERVAL = 3;

  private state: MonitorState;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    phaseTracker: PhaseTracker,
    queueAdapter: QueueAdapter,
    config: MonitorConfig,
    repositories: RepositoryConfig[],
    clusterGithubUsername?: string,
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.phaseTracker = phaseTracker;
    this.queueAdapter = queueAdapter;
    this.clusterGithubUsername = clusterGithubUsername;
    this.options = {
      repositories,
      pollIntervalMs: config.pollIntervalMs,
      adaptivePolling: config.adaptivePolling,
      maxConcurrentPolls: config.maxConcurrentPolls,
    };

    this.state = {
      isPolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: config.pollIntervalMs,
      basePollIntervalMs: config.pollIntervalMs,
    };
  }

  // ==========================================================================
  // Label Parsing
  // ==========================================================================

  /**
   * Parse a label event from a label name, determining if it's a process
   * trigger or a resume event.
   */
  parseLabelEvent(
    labelName: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueLabels: string[],
    source: 'webhook' | 'poll',
  ): LabelEvent | null {
    // Check for process:* trigger labels
    if (labelName.startsWith(PROCESS_LABEL_PREFIX)) {
      const workflowName = labelName.slice(PROCESS_LABEL_PREFIX.length);
      if (!workflowName) return null;

      return {
        type: 'process',
        owner,
        repo,
        issueNumber,
        labelName,
        parsedName: workflowName,
        source,
        issueLabels,
      };
    }

    // Check for completed:* labels (resume detection)
    if (labelName.startsWith(COMPLETED_LABEL_PREFIX)) {
      const phaseName = labelName.slice(COMPLETED_LABEL_PREFIX.length);
      if (!phaseName) return null;

      // Check for matching waiting-for:* label
      const waitingLabel = `${WAITING_FOR_LABEL_PREFIX}${phaseName}`;
      if (issueLabels.includes(waitingLabel)) {
        return {
          type: 'resume',
          owner,
          repo,
          issueNumber,
          labelName,
          parsedName: phaseName,
          source,
          issueLabels,
        };
      }

      this.logger.info(
        { labelName, owner, repo, issueNumber, expectedWaitingLabel: waitingLabel, source },
        'completed:* label seen without matching waiting-for:* label',
      );
    }

    return null;
  }

  // ==========================================================================
  // Webhook Verification
  // ==========================================================================

  /**
   * Re-fetch issue labels from GitHub and retry resume detection.
   * Called when a webhook delivers a completed:* label but the payload's
   * issueLabels didn't contain a matching waiting-for:* label (stale payload).
   */
  async verifyAndProcessCompletedLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    labelName: string,
  ): Promise<boolean> {
    this.logger.info(
      { owner, repo, issueNumber, labelName },
      'Re-fetching issue labels for completed:* verification',
    );

    let freshLabels: string[];
    try {
      const client = this.createClient();
      const issue = await client.getIssue(owner, repo, issueNumber);
      freshLabels = issue.labels.map(l => typeof l === 'string' ? l : l.name);
    } catch (error) {
      this.logger.error(
        { err: String(error), owner, repo, issueNumber, labelName },
        'Failed to re-fetch issue labels for completed:* verification',
      );
      return false;
    }

    const event = this.parseLabelEvent(
      labelName, owner, repo, issueNumber, freshLabels, 'webhook',
    );

    if (!event) {
      this.logger.info(
        { owner, repo, issueNumber, labelName },
        'Re-fetch confirmed: no matching waiting-for:* label on issue',
      );
      return false;
    }

    this.logger.info(
      { owner, repo, issueNumber, labelName, type: event.type },
      'Re-fetch found matching waiting-for:* label, processing resume event',
    );

    return this.processLabelEvent(event);
  }

  // ==========================================================================
  // Workflow Resolution
  // ==========================================================================

  /**
   * Resolve workflow name from a workflow:* label on the issue.
   * Falls back to 'speckit-feature' for backward compatibility with
   * pre-existing issues that lack a workflow: label.
   */
  private resolveWorkflowFromLabels(issueLabels: string[]): string {
    const WORKFLOW_LABEL_PREFIX = 'workflow:';
    const workflowLabel = issueLabels.find(l => l.startsWith(WORKFLOW_LABEL_PREFIX));
    if (workflowLabel) {
      return workflowLabel.slice(WORKFLOW_LABEL_PREFIX.length);
    }
    return 'speckit-feature';
  }

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  /**
   * Process a label event: check dedup, enqueue, manage labels.
   * Shared by both webhook and polling paths.
   */
  async processLabelEvent(event: LabelEvent): Promise<boolean> {
    const { type, owner, repo, issueNumber, parsedName, source } = event;

    this.logger.info(
      { type, owner, repo, issueNumber, parsedName, source },
      `Processing ${type} label event`,
    );

    // Deduplication: prevents webhook+poll race from double-processing.
    // For 'process' events, clear any existing dedup key first so the issue
    // can be re-queued after a failure or completion. The label removal after
    // processing prevents the poll from re-detecting the same label.
    const dedupPhase = type === 'process' ? parsedName : `resume:${parsedName}`;

    if (type === 'process') {
      await this.phaseTracker.clear(owner, repo, issueNumber, dedupPhase);
    }

    const isDuplicate = await this.phaseTracker.isDuplicate(owner, repo, issueNumber, dedupPhase);
    if (isDuplicate) {
      this.logger.info(
        { owner, repo, issueNumber, phase: dedupPhase },
        'Skipping duplicate event',
      );
      return false;
    }

    // Resolve workflow name: for process events, use parsedName directly;
    // for resume events, read the workflow:* label from the issue.
    const workflowName = type === 'resume'
      ? this.resolveWorkflowFromLabels(event.issueLabels)
      : parsedName;

    if (type === 'resume' && !event.issueLabels.some(l => l.startsWith('workflow:'))) {
      this.logger.warn(
        { owner, repo, issueNumber, defaultedTo: 'speckit-feature' },
        'No workflow: label found on issue, defaulting to speckit-feature',
      );
    }

    // Fetch issue description for queue metadata
    let description = `Issue #${issueNumber}`;
    let fetchedIssue: Awaited<ReturnType<ReturnType<GitHubClientFactory>['getIssue']>> | null = null;
    try {
      const client = this.createClient();
      fetchedIssue = await client.getIssue(owner, repo, issueNumber);
      description = fetchedIssue.body || fetchedIssue.title;
    } catch (error) {
      this.logger.warn(
        { err: String(error), owner, repo, issueNumber },
        'Failed to fetch issue details, using fallback description',
      );
    }

    // Build queue item
    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: type === 'process' ? 'process' : 'continue',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: { description },
    };

    // Enqueue
    await this.queueAdapter.enqueue(queueItem);
    this.logger.info(
      { owner, repo, issueNumber, command: queueItem.command, workflowName },
      'Issue enqueued',
    );

    // Mark as processed for dedup
    await this.phaseTracker.markProcessed(owner, repo, issueNumber, dedupPhase);

    // Manage labels via GitHubClient
    if (type === 'process') {
      // Remove trigger label, agent:error, and all completed:* labels from previous runs.
      // Without clearing completed:* labels, requeued issues skip already-labeled phases
      // even if the prior run failed mid-implementation.
      try {
        // Reuse issue data from description fetch if available, otherwise re-fetch
        const issue = fetchedIssue ?? await this.createClient().getIssue(owner, repo, issueNumber);
        const completedLabels = issue.labels
          .map(l => typeof l === 'string' ? l : l.name)
          .filter(name => name.startsWith(COMPLETED_LABEL_PREFIX));

        const labelsToRemove = [event.labelName, 'agent:error', ...completedLabels];
        const client = this.createClient();
        await client.removeLabels(owner, repo, issueNumber, labelsToRemove);
        await client.addLabels(owner, repo, issueNumber, [
          AGENT_IN_PROGRESS_LABEL,
          `workflow:${parsedName}`,
        ]);
      } catch (error) {
        this.logger.warn(
          { err: error, owner, repo, issueNumber },
          'Failed to update labels after process enqueue',
        );
      }
    }
    // Note: waiting-for:* label removal for resume events is handled by the
    // worker (labelManager.onResumeStart) to avoid a race condition where
    // the label is removed before the worker reads it for phase resolution.

    return true;
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  /**
   * Start the polling loop.
   */
  async startPolling(): Promise<void> {
    if (this.state.isPolling) {
      this.logger.warn('Polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.state.isPolling = true;
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, repos: this.options.repositories.length },
      'Starting label monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during poll cycle',
        );
      }

      // Update adaptive polling before sleeping
      if (this.options.adaptivePolling) {
        this.updateAdaptivePolling();
      }

      await this.sleep(this.state.currentPollIntervalMs, ac.signal);
    }

    this.state.isPolling = false;
    this.logger.info('Polling loop stopped');
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('Polling stop requested');
    }
  }

  /**
   * Run a single poll cycle across all watched repositories.
   * Process:* labels are checked every cycle (2 labels × N repos).
   * Completed:* labels for resume detection are checked every Nth cycle.
   */
  async poll(): Promise<void> {
    const repos = this.options.repositories;
    if (repos.length === 0) return;

    this.pollCycleCount++;
    const checkCompleted = this.pollCycleCount % LabelMonitorService.COMPLETED_CHECK_INTERVAL === 0;

    // Use semaphore pattern for concurrency limiting
    const semaphore = new Semaphore(this.options.maxConcurrentPolls);

    const pollTasks = repos.map(({ owner, repo }) =>
      semaphore.acquire().then(async (release) => {
        try {
          await this.pollRepo(owner, repo, checkCompleted);
        } finally {
          release();
        }
      }),
    );

    await Promise.allSettled(pollTasks);
  }

  /**
   * Poll a single repository for trigger labels.
   * Uses known label names from WORKFLOW_LABELS to avoid GraphQL listLabels calls.
   * listIssuesWithLabel uses the REST API (separate rate limit bucket).
   *
   * @param checkCompleted - Whether to also check completed:* labels for resume detection
   */
  private async pollRepo(owner: string, repo: string, checkCompleted: boolean): Promise<void> {
    const client = this.createClient();

    try {
      // Check known process:* labels for issues (REST API, 2 calls per repo)
      for (const processLabel of KNOWN_PROCESS_LABELS) {
        const allIssues = await client.listIssuesWithLabel(owner, repo, processLabel);
        const issues = filterByAssignee(allIssues, this.clusterGithubUsername, this.logger);
        for (const issue of issues) {
          const event = this.parseLabelEvent(
            processLabel,
            owner,
            repo,
            issue.number,
            issue.labels.map(l => l.name),
            'poll',
          );
          if (event) {
            await this.processLabelEvent(event);
          }
        }
      }

      // Check known completed:* labels for resume pairs (REST API, 13 calls per repo)
      // Only checked periodically to conserve API rate limit
      if (checkCompleted) {
        for (const completedLabel of KNOWN_COMPLETED_LABELS) {
          const allIssues = await client.listIssuesWithLabel(owner, repo, completedLabel);
          const issues = filterByAssignee(allIssues, this.clusterGithubUsername, this.logger);
          for (const issue of issues) {
            const issueLabels = issue.labels.map(l => l.name);
            const event = this.parseLabelEvent(
              completedLabel,
              owner,
              repo,
              issue.number,
              issueLabels,
              'poll',
            );
            if (event) {
              await this.processLabelEvent(event);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, owner, repo },
        'Error polling repository',
      );
    }
  }

  // ==========================================================================
  // Adaptive Polling
  // ==========================================================================

  /**
   * Record that a webhook event was received, updating health tracking.
   */
  recordWebhookEvent(): void {
    this.state.lastWebhookEvent = Date.now();
    const wasUnhealthy = !this.state.webhookHealthy;
    this.state.webhookHealthy = true;

    if (wasUnhealthy) {
      this.state.currentPollIntervalMs = this.state.basePollIntervalMs;
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs },
        'Webhook reconnected, restoring normal poll interval',
      );
    }
  }

  /**
   * Update adaptive polling interval based on webhook health.
   */
  private updateAdaptivePolling(): void {
    if (this.state.lastWebhookEvent === null) {
      // No webhook events yet — treat as healthy (no data, not unhealthy)
      return;
    }

    const timeSinceLastWebhook = Date.now() - this.state.lastWebhookEvent;
    const unhealthyThreshold = this.state.basePollIntervalMs * 2;

    if (timeSinceLastWebhook > unhealthyThreshold && this.state.webhookHealthy) {
      // Webhooks went unhealthy — increase poll frequency
      this.state.webhookHealthy = false;
      this.state.currentPollIntervalMs = Math.max(
        MIN_POLL_INTERVAL_MS,
        Math.floor(this.state.basePollIntervalMs / ADAPTIVE_DIVISOR),
      );
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs, timeSinceLastWebhook },
        'Webhooks appear unhealthy, increasing poll frequency',
      );
    }
  }

  // ==========================================================================
  // State Access
  // ==========================================================================

  getState(): Readonly<MonitorState> {
    return { ...this.state };
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

      // Clean up timer if abort is signaled
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Simple semaphore for concurrency limiting.
 */
class Semaphore {
  private count: number;
  private waiting: Array<() => void> = [];

  constructor(max: number) {
    this.count = max;
  }

  async acquire(): Promise<() => void> {
    if (this.count > 0) {
      this.count--;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.waiting.push(() => {
        this.count--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.count++;
    const next = this.waiting.shift();
    if (next) {
      next();
    }
  }
}
