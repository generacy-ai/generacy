/**
 * #898 T014 — Poll-based monitor that enqueues `resolve-merge-conflicts`
 * queue items for issues sitting at `waiting-for:merge-conflicts` + `agent:paused`.
 *
 * Shape template: `pr-feedback-monitor-service.ts`.
 * Contract: `specs/898-found-during-cockpit-v1/contracts/monitor-contract.md`.
 *
 * Dedup mechanism: sole use of `QueueManager.enqueueIfAbsent(itemKey)` — no
 * `phase-tracker:*:resume:*` key. In-flight collisions collapse silently.
 * Blocked-label pre-enqueue skip mirrors the `#883` pattern.
 */
import {
  GhAuthError,
  type GitHubClientFactory,
} from '@generacy-ai/workflow-engine';
import { JitTokenError } from '@generacy-ai/control-plane';
import type {
  MonitorState,
  QueueManager,
  QueueItem,
} from '../types/monitor.js';
import type { RepositoryConfig, PrMonitorConfig } from '../config/schema.js';
import type { Logger } from '../worker/types.js';
import { filterByAssignee } from './identity.js';
import type { AuthHealthSink } from './label-monitor-service.js';
import { decideAdaptivePoll } from './adaptive-poll-controller.js';

const WAITING_FOR_MERGE_CONFLICTS_LABEL = 'waiting-for:merge-conflicts';
const AGENT_PAUSED_LABEL = 'agent:paused';
const MIN_POLL_INTERVAL_MS = 10_000;
/**
 * Adaptive polling divisor — halves poll interval when webhook stream goes
 * quiet. Matches `PrFeedbackMonitorService` (Q divisor from #869).
 */
const ADAPTIVE_DIVISOR = 2;

/**
 * Event shape for a detected merge-conflict pause. Shared between webhook
 * (future) and poll paths.
 */
export interface MergeConflictEvent {
  owner: string;
  repo: string;
  issueNumber: number;
  /** Full labels on the issue at detection time. */
  issueLabels: string[];
  /** How this event was detected. */
  source: 'webhook' | 'poll';
}

export interface MergeConflictMonitorOptions {
  repositories: RepositoryConfig[];
  pollIntervalMs: number;
  adaptivePolling: boolean;
  maxConcurrentPolls: number;
}

/**
 * #987: options for the runtime `setWebhooksConfigured(true, opts?)` flip.
 * See specs/987-summary-cluster-where-smee/contracts/setter-contract.md.
 */
export interface SetWebhooksConfiguredOptions {
  basePollIntervalMs?: number;
}

/**
 * MergeConflictMonitorService — enqueues `resolve-merge-conflicts` work when
 * the pause state (`waiting-for:merge-conflicts + agent:paused`) is detected
 * on an assigned open issue.
 */
export class MergeConflictMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly queueManager: QueueManager;
  private readonly options: MergeConflictMonitorOptions;
  private readonly clusterGithubUsername: string | undefined;
  private readonly authHealth: AuthHealthSink;
  private readonly githubAppCredentialId: string | undefined;
  private abortController: AbortController | null = null;
  private state: MonitorState;

  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueManager: QueueManager,
    config: PrMonitorConfig,
    repositories: RepositoryConfig[],
    clusterGithubUsername?: string,
    tokenProvider?: () => Promise<string | undefined>,
    authHealth?: AuthHealthSink,
    githubAppCredentialId?: string,
    webhooksConfigured: boolean = false,
  ) {
    this.logger = logger;
    this.createClient = createClient;
    this.tokenProvider = tokenProvider;
    this.queueManager = queueManager;
    this.clusterGithubUsername = clusterGithubUsername;
    this.authHealth = authHealth ?? { recordResult: () => undefined };
    this.githubAppCredentialId = githubAppCredentialId;
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
      webhooksConfigured,
    };
  }

  // ==========================================================================
  // Event Processing
  // ==========================================================================

  /**
   * Process a merge-conflict event: verify precondition, check blocked-label
   * skip, resolve workflow name, enqueue via `enqueueIfAbsent`.
   *
   * Returns true if enqueued, false if skipped or duplicate.
   */
  async processMergeConflictEvent(event: MergeConflictEvent): Promise<boolean> {
    const { owner, repo, issueNumber, issueLabels, source } = event;

    // Precondition: both waiting-for:merge-conflicts AND agent:paused must be
    // present. Missing agent:paused → drop (pause is not actually in place).
    const hasWaitingFor = issueLabels.includes(WAITING_FOR_MERGE_CONFLICTS_LABEL);
    const hasPaused = issueLabels.includes(AGENT_PAUSED_LABEL);
    if (!hasWaitingFor || !hasPaused) {
      this.logger.debug(
        {
          owner, repo, issueNumber, source,
          hasWaitingFor, hasPaused,
        },
        'Precondition failed for merge-conflict enqueue (need waiting-for + agent:paused)',
      );
      return false;
    }

    // Blocked-label skip: any `blocked:*` on the issue → do not enqueue.
    // Operator removes the block label → next poll re-enables enqueue naturally.
    const blockedLabel = issueLabels.find((l) => l.startsWith('blocked:'));
    if (blockedLabel) {
      this.logger.info(
        {
          owner, repo, issueNumber,
          blockedLabel,
          reason: 'blocked-label-present',
        },
        'Skipping merge-conflict enqueue while blocked:* label is present',
      );
      return false;
    }

    // Resolve workflow name from labels; default speckit-feature.
    const workflowLabel = issueLabels.find((l) => l.startsWith('workflow:'));
    const workflowName = workflowLabel
      ? workflowLabel.slice('workflow:'.length)
      : 'speckit-feature';

    // Build queue item.
    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: 'resolve-merge-conflicts',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {},
      queueReason: 'resume',
    };

    // Atomic enqueue via in-flight dedupe (#862/#879 pattern).
    const itemKey = `${owner}/${repo}#${issueNumber}`;
    const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
    if (!enqueued) {
      this.logger.info(
        { itemKey, reason: 'in-flight', owner, repo, issueNumber },
        'Dropping merge-conflict enqueue (item already in flight)',
      );
      return false;
    }

    this.logger.info(
      { owner, repo, issueNumber, command: queueItem.command, source },
      'Merge-conflict resolution enqueued',
    );
    return true;
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  async startPolling(): Promise<void> {
    if (this.state.isPolling) {
      this.logger.warn('Merge-conflict monitor polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.state.isPolling = true;
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, repos: this.options.repositories.length },
      'Starting merge-conflict monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during merge-conflict poll cycle',
        );
      }

      if (this.options.adaptivePolling) {
        this.updateAdaptivePolling();
      }

      await this.sleep(this.state.currentPollIntervalMs, ac.signal);
    }

    this.state.isPolling = false;
    this.logger.info('Merge-conflict monitor polling loop stopped');
  }

  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('Merge-conflict monitor polling stop requested');
    }
  }

  async poll(): Promise<void> {
    const repos = this.options.repositories;
    if (repos.length === 0) return;

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
   * Poll a single repository for issues sitting at `waiting-for:merge-conflicts`.
   * Filters by assignee, then processes each via `processMergeConflictEvent`.
   */
  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient(undefined, this.tokenProvider);

    let allIssues;
    try {
      allIssues = await client.listIssuesWithLabel(
        owner,
        repo,
        WAITING_FOR_MERGE_CONFLICTS_LABEL,
      );
      if (this.githubAppCredentialId) {
        this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
      }
    } catch (error) {
      if (error instanceof JitTokenError) {
        this.logger.warn(
          { code: error.code, message: error.message, owner, repo },
          'JIT GitHub token refresh failed — skipping merge-conflict monitor cycle',
        );
        return;
      }
      if (error instanceof GhAuthError) {
        if (this.githubAppCredentialId) {
          this.authHealth.recordResult(
            this.githubAppCredentialId,
            { ok: false, statusCode: error.statusCode },
          );
        }
        this.logger.warn(
          { credentialId: this.githubAppCredentialId, statusCode: error.statusCode, owner, repo },
          'GitHub authentication failing on merge-conflict monitor — investigate credential refresh chain',
        );
        return;
      }
      this.logger.warn(
        { err: String(error), owner, repo },
        'Error polling repository for merge-conflict pauses',
      );
      return;
    }

    const issues = filterByAssignee(allIssues, this.clusterGithubUsername, this.logger);

    if (issues.length === 0) {
      this.logger.debug({ owner, repo }, 'No merge-conflict pauses found this cycle');
      return;
    }

    this.logger.info(
      { owner, repo, count: issues.length },
      'Merge-conflict pauses found',
    );

    for (const issue of issues) {
      const event: MergeConflictEvent = {
        owner,
        repo,
        issueNumber: issue.number,
        issueLabels: issue.labels.map((l) => l.name),
        source: 'poll',
      };
      try {
        await this.processMergeConflictEvent(event);
      } catch (err) {
        this.logger.warn(
          { err: String(err), owner, repo, issueNumber: issue.number },
          'Error processing merge-conflict event — continuing to next issue',
        );
      }
    }
  }

  // ==========================================================================
  // Adaptive Polling
  // ==========================================================================

  recordWebhookEvent(): void {
    this.state.lastWebhookEvent = Date.now();
    this.state.webhookHealthy = true;
    const decision = decideAdaptivePoll({
      webhooksConfigured: this.state.webhooksConfigured,
      adaptivePolling: this.options.adaptivePolling,
      basePollIntervalMs: this.state.basePollIntervalMs,
      currentPollIntervalMs: this.state.currentPollIntervalMs,
      lastWebhookEvent: this.state.lastWebhookEvent,
      webhookHealthy: this.state.webhookHealthy,
      adaptiveDivisor: ADAPTIVE_DIVISOR,
      minPollIntervalMs: MIN_POLL_INTERVAL_MS,
      nowMs: Date.now(),
    });
    this.state.currentPollIntervalMs = decision.currentPollIntervalMs;
    this.state.webhookHealthy = decision.webhookHealthy;
    if (decision.transition !== 'none') {
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs, reason: decision.reason },
        'Webhook reconnected, restoring merge-conflict monitor poll interval',
      );
    }
  }

  private updateAdaptivePolling(): void {
    const decision = decideAdaptivePoll({
      webhooksConfigured: this.state.webhooksConfigured,
      adaptivePolling: this.options.adaptivePolling,
      basePollIntervalMs: this.state.basePollIntervalMs,
      currentPollIntervalMs: this.state.currentPollIntervalMs,
      lastWebhookEvent: this.state.lastWebhookEvent,
      webhookHealthy: this.state.webhookHealthy,
      adaptiveDivisor: ADAPTIVE_DIVISOR,
      minPollIntervalMs: MIN_POLL_INTERVAL_MS,
      nowMs: Date.now(),
    });
    this.state.currentPollIntervalMs = decision.currentPollIntervalMs;
    this.state.webhookHealthy = decision.webhookHealthy;
    if (decision.transition !== 'none') {
      this.logger.info(
        { intervalMs: this.state.currentPollIntervalMs, reason: decision.reason },
        'Webhooks appear unhealthy, increasing merge-conflict poll frequency',
      );
    }
  }

  // ==========================================================================
  // State access
  // ==========================================================================

  getState(): Readonly<MonitorState> {
    return { ...this.state };
  }

  /**
   * #987: flip `webhooksConfigured` to `true` at runtime. Setter is one-way
   * (Q1); `adaptivePolling` stays untouched so the staleness safety net is
   * reachable (Q2). See specs/987-summary-cluster-where-smee/clarifications.md.
   */
  setWebhooksConfigured(configured: true, opts?: SetWebhooksConfiguredOptions): void {
    void configured;
    this.state.webhooksConfigured = true;
    if (opts?.basePollIntervalMs !== undefined) {
      this.state.basePollIntervalMs = opts.basePollIntervalMs;
      this.state.currentPollIntervalMs = opts.basePollIntervalMs;
    }
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

/**
 * Simple semaphore for bounded concurrency.
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
    if (next) next();
  }
}
