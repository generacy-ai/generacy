import type { GitHubClientFactory } from '@generacy-ai/workflow-engine';
import type {
  MonitorState,
  QueueAdapter,
  PhaseTracker,
  QueueItem,
  PrReviewEvent,
  PrFeedbackMetadata,
} from '../types/monitor.js';
import type { RepositoryConfig, PrMonitorConfig } from '../config/schema.js';
import { PrLinker, type PrLinkInput } from '../worker/pr-linker.js';
import type { Logger } from '../worker/types.js';

export interface PrFeedbackMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}

const WAITING_FOR_PR_FEEDBACK_LABEL = 'waiting-for:address-pr-feedback';
const DEDUP_PHASE = 'address-pr-feedback';
const MIN_POLL_INTERVAL_MS = 10000;
/**
 * Adaptive polling divisor for PR feedback monitor.
 * Per US4: "Polling interval decreases by 50%" → divide by 2.
 * This differs from LabelMonitorService which uses ADAPTIVE_DIVISOR = 3.
 */
const ADAPTIVE_DIVISOR = 2;

/**
 * PR feedback monitor service that detects unresolved review comments
 * on PRs linked to orchestrated issues and triggers the feedback-addressing flow.
 *
 * Uses a hybrid webhook + polling architecture mirroring LabelMonitorService.
 */
export class PrFeedbackMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly phaseTracker: PhaseTracker;
  private readonly queueAdapter: QueueAdapter;
  private readonly options: PrFeedbackMonitorOptions;
  private readonly prLinker: PrLinker;
  private abortController: AbortController | null = null;

  private state: MonitorState;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    phaseTracker: PhaseTracker,
    queueAdapter: QueueAdapter,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.phaseTracker = phaseTracker;
    this.queueAdapter = queueAdapter;
    this.options = {
      repositories,
      pollIntervalMs: config.pollIntervalMs,
      adaptivePolling: config.adaptivePolling,
      maxConcurrentPolls: config.maxConcurrentPolls,
    };
    this.prLinker = new PrLinker(logger);

    this.state = {
      isPolling: false,
      webhookHealthy: true,
      lastWebhookEvent: null,
      currentPollIntervalMs: config.pollIntervalMs,
      basePollIntervalMs: config.pollIntervalMs,
    };
  }

  // ==========================================================================
  // PR Review Event Processing
  // ==========================================================================

  /**
   * Process a PR review event: link PR to issue, check for unresolved threads,
   * deduplicate, and enqueue feedback-addressing work.
   *
   * Shared by both webhook and polling paths.
   *
   * @returns true if feedback was enqueued, false if skipped or duplicate
   */
  async processPrReviewEvent(event: PrReviewEvent): Promise<boolean> {
    const { owner, repo, prNumber, prBody, branchName, source } = event;

    this.logger.info(
      { owner, repo, prNumber, source },
      `Processing PR review event from ${source}`,
    );

    const client = this.createClient();

    // 1. Link PR to orchestrated issue
    const prInput: PrLinkInput = {
      number: prNumber,
      body: prBody,
      head: { ref: branchName },
    };

    const link = await this.prLinker.linkPrToIssue(client, owner, repo, prInput);
    if (!link) {
      this.logger.debug(
        { owner, repo, prNumber },
        'PR not linked to an orchestrated issue — skipping',
      );
      return false;
    }

    const { issueNumber, linkMethod } = link;

    // 2. Fetch review comments and filter for unresolved threads
    let unresolvedThreadIds: number[];
    try {
      const comments = await client.getPRComments(owner, repo, prNumber);
      // Filter for root-level unresolved comments (not replies)
      const unresolvedComments = comments.filter(
        (c) => c.resolved === false && !c.in_reply_to_id,
      );
      unresolvedThreadIds = unresolvedComments.map((c) => c.id);
    } catch (error) {
      this.logger.error(
        { err: error, owner, repo, prNumber },
        'Failed to fetch PR comments',
      );
      return false;
    }

    if (unresolvedThreadIds.length === 0) {
      this.logger.debug(
        { owner, repo, prNumber, issueNumber },
        'No unresolved review threads — skipping',
      );
      return false;
    }

    this.logger.info(
      { owner, repo, prNumber, issueNumber, linkMethod, unresolvedCount: unresolvedThreadIds.length },
      `Found ${unresolvedThreadIds.length} unresolved review thread(s)`,
    );

    // 3. Atomic deduplication via tryMarkProcessed (SET NX)
    const isNew = await this.phaseTracker.tryMarkProcessed(
      owner, repo, issueNumber, DEDUP_PHASE,
    );
    if (!isNew) {
      this.logger.info(
        { owner, repo, issueNumber, prNumber },
        'Skipping duplicate — PR feedback already enqueued for this issue',
      );
      return false;
    }

    // 4. Resolve workflow name from issue labels
    const workflowName = await this.resolveWorkflowName(owner, repo, issueNumber);

    // 5. Build and enqueue queue item
    const metadata: PrFeedbackMetadata = {
      prNumber,
      reviewThreadIds: unresolvedThreadIds,
    };

    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: 'address-pr-feedback',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: metadata as unknown as Record<string, unknown>,
    };

    await this.queueAdapter.enqueue(queueItem);
    this.logger.info(
      { owner, repo, issueNumber, prNumber, command: queueItem.command },
      'PR feedback work enqueued',
    );

    // 6. Add waiting-for label to issue
    try {
      await client.addLabels(owner, repo, issueNumber, [WAITING_FOR_PR_FEEDBACK_LABEL]);
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to add waiting-for:address-pr-feedback label',
      );
    }

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
      this.logger.warn('PR feedback polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.state.isPolling = true;
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, repos: this.options.repositories.length },
      'Starting PR feedback monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during PR feedback poll cycle',
        );
      }

      // Update adaptive polling before sleeping
      if (this.options.adaptivePolling) {
        this.updateAdaptivePolling();
      }

      await this.sleep(this.state.currentPollIntervalMs, ac.signal);
    }

    this.state.isPolling = false;
    this.logger.info('PR feedback polling loop stopped');
  }

  /**
   * Stop the polling loop.
   */
  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('PR feedback polling stop requested');
    }
  }

  /**
   * Run a single poll cycle across all watched repositories.
   * Lists open PRs in each repo, checks for unresolved review threads.
   */
  async poll(): Promise<void> {
    const repos = this.options.repositories;
    if (repos.length === 0) return;

    // Use semaphore pattern for concurrency limiting
    const semaphore = new Semaphore(this.options.maxConcurrentPolls);

    const pollTasks = repos.map(({ owner, repo }) =>
      semaphore.acquire().then(async (release) => {
        try {
          await this.pollRepo(owner, repo);
        } finally {
          release();
        }
      }),
    );

    await Promise.allSettled(pollTasks);
  }

  /**
   * Poll a single repository for PRs with unresolved review threads.
   * Lists open PRs and processes each through the standard event flow.
   */
  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient();

    let openPRs;
    try {
      openPRs = await client.listOpenPullRequests(owner, repo);
    } catch (error) {
      if (this.isRateLimitError(error)) {
        this.logger.warn(
          { owner, repo },
          'GitHub API rate limit hit while listing open PRs — skipping repo this cycle',
        );
        return;
      }
      this.logger.error(
        { err: error, owner, repo },
        'Error polling repository for open PRs',
      );
      return;
    }

    // FR-015: When multiple PRs exist for the same issue, process only the
    // most recently updated PR. Use a lightweight pre-link pass (body/branch
    // parsing only, no API calls) to group PRs by candidate issue number.
    const prsToProcess = this.deduplicatePrsByIssue(owner, repo, openPRs);

    for (const pr of prsToProcess) {
      const event: PrReviewEvent = {
        owner,
        repo,
        prNumber: pr.number,
        prBody: pr.body ?? '',
        branchName: pr.head.ref,
        source: 'poll',
      };

      try {
        await this.processPrReviewEvent(event);
      } catch (error) {
        if (this.isRateLimitError(error)) {
          this.logger.warn(
            { owner, repo, prNumber: pr.number },
            'GitHub API rate limit hit while processing PR — stopping repo poll',
          );
          return;
        }
        this.logger.error(
          { err: error, owner, repo, prNumber: pr.number },
          'Error processing PR during poll',
        );
      }
    }
  }

  /**
   * FR-015: Deduplicate PRs that link to the same issue, keeping only the
   * most recently updated PR per issue. Uses lightweight body/branch parsing
   * (no API calls) to determine candidate issue numbers.
   *
   * PRs that don't resolve to any issue number are kept as-is (they'll be
   * filtered out later by `processPrReviewEvent` when linking fails).
   */
  private deduplicatePrsByIssue(
    owner: string,
    repo: string,
    prs: Array<{ number: number; body: string; head: { ref: string }; updated_at: string }>,
  ): typeof prs {
    // Group PRs by candidate issue number
    const issueGroups = new Map<number, typeof prs>();
    const unlinked: typeof prs = [];

    for (const pr of prs) {
      const candidateIssue =
        this.prLinker.parsePrBody(pr.body) ??
        this.prLinker.parseBranchName(pr.head.ref);

      if (candidateIssue === null) {
        unlinked.push(pr);
        continue;
      }

      const group = issueGroups.get(candidateIssue);
      if (group) {
        group.push(pr);
      } else {
        issueGroups.set(candidateIssue, [pr]);
      }
    }

    const result: typeof prs = [...unlinked];

    for (const [issueNumber, group] of issueGroups) {
      if (group.length === 1) {
        result.push(group[0]!);
        continue;
      }

      // Sort by updated_at descending — most recent first
      group.sort((a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );

      const mostRecent = group[0]!;
      result.push(mostRecent);

      // Log warning for skipped older PRs
      const skipped = group.slice(1);
      for (const skippedPr of skipped) {
        this.logger.warn(
          { owner, repo, issueNumber, skippedPrNumber: skippedPr.number, processedPrNumber: mostRecent.number },
          `Skipping older PR #${skippedPr.number} for issue #${issueNumber} — processing most recent PR #${mostRecent.number}`,
        );
      }
    }

    return result;
  }

  /**
   * Check if an error is a GitHub API rate limit error.
   */
  private isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes('rate limit') || msg.includes('api rate') || msg.includes('403');
    }
    return false;
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
        'Webhook reconnected, restoring normal PR feedback poll interval',
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
        'Webhooks appear unhealthy, increasing PR feedback poll frequency',
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

  /**
   * Resolve workflow name from the issue's labels.
   * Checks workflow:* labels first (authoritative, set by label monitor on process events),
   * then falls back to process:* / completed:* / agent:* for pre-migration issues.
   * Falls back to 'unknown' if no workflow label is found.
   */
  private async resolveWorkflowName(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<string> {
    try {
      const client = this.createClient();
      const issue = await client.getIssue(owner, repo, issueNumber);

      // Primary: persistent workflow:* label (authoritative)
      for (const label of issue.labels) {
        if (label.name.startsWith('workflow:')) {
          return label.name.slice('workflow:'.length);
        }
      }

      // Fallback: existing logic for pre-migration issues
      for (const label of issue.labels) {
        if (label.name.startsWith('process:')) {
          return label.name.slice('process:'.length);
        }
        if (label.name.startsWith('completed:')) {
          return label.name.slice('completed:'.length);
        }
      }

      // Check agent:* labels for workflow name fallback
      for (const label of issue.labels) {
        if (label.name.startsWith('agent:') && label.name !== 'agent:in-progress' && label.name !== 'agent:error' && label.name !== 'agent:dispatched' && label.name !== 'agent:paused') {
          return label.name.slice('agent:'.length);
        }
      }
    } catch (error) {
      this.logger.warn(
        { err: error, owner, repo, issueNumber },
        'Failed to resolve workflow name from issue labels',
      );
    }

    return 'unknown';
  }

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
