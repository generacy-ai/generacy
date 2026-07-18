/**
 * #958 T013 — Poll-based monitor that enqueues `continue` resume queue items
 * for issues sitting at `waiting-for:clarification` + `agent:paused` when a
 * new human-authored comment appears.
 *
 * Shape template: `merge-conflict-monitor-service.ts` (spec §Assumptions).
 * Contract: `specs/958-found-during-local-snappoll/contracts/
 *   clarification-answer-monitor.md`.
 *
 * Key divergences from the merge-conflict monitor (per data-model.md):
 *   - Precondition label: `waiting-for:clarification` (was `waiting-for:merge-conflicts`).
 *   - Additional predicate: at least one comment with `viewerDidAuthor === false`
 *     that also passes `isTrustedCommentAuthor(_, 'answer-scanner', trustCtx)`.
 *     Comments carrying the engine-written answer marker are treated as
 *     cluster-self (not counted).
 *   - Queue command: `command: 'continue'` (was `'resolve-merge-conflicts'`).
 *
 * Non-behavior (contract):
 *   - MUST NOT apply `completed:clarification`. That label is reserved for
 *     the human's explicit force-advance override (FR-011).
 *   - MUST NOT modify `clarifications.md` — the monitor has no checkout; the
 *     phase loop performs integration on the resume path.
 *   - MUST NOT clear `waiting-for:clarification` or `agent:paused`.
 */
import {
  GhAuthError,
  isTrustedCommentAuthor,
  tryLoadCommentTrustConfig,
  type CommentTrustContext,
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
import { commentCarriesMachineMarker } from '../worker/clarification-markers.js';
import { decideAdaptivePoll } from './adaptive-poll-controller.js';

const WAITING_FOR_CLARIFICATION_LABEL = 'waiting-for:clarification';
const AGENT_PAUSED_LABEL = 'agent:paused';
const MIN_POLL_INTERVAL_MS = 10_000;
const ADAPTIVE_DIVISOR = 2;

export interface ClarificationAnswerEvent {
  owner: string;
  repo: string;
  issueNumber: number;
  issueLabels: string[];
  source: 'poll';
}

export interface ClarificationAnswerMonitorOptions {
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
 * Adapter: pino-style logger (WorkerContext.Logger) → workflow-engine Logger.
 * Same bridge used by `clarification-poster.ts` — kept private to this file
 * so the merge-conflict monitor's DI surface stays untouched.
 */
function toEngineLogger(logger: Logger): CommentTrustContext['logger'] {
  return {
    info: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.info(meta as Record<string, unknown>, msg);
      else logger.info(msg);
    },
    warn: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.warn(meta as Record<string, unknown>, msg);
      else logger.warn(msg);
    },
    error: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.error(meta as Record<string, unknown>, msg);
      else logger.error(msg);
    },
    debug: (msg: string, meta?: unknown) => {
      if (meta && typeof meta === 'object') logger.debug(meta as Record<string, unknown>, msg);
      else logger.debug(msg);
    },
  };
}

export class ClarificationAnswerMonitorService {
  private readonly logger: Logger;
  private readonly createClient: GitHubClientFactory;
  private readonly tokenProvider?: () => Promise<string | undefined>;
  private readonly queueManager: QueueManager;
  private readonly options: ClarificationAnswerMonitorOptions;
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
   * Process a clarification-answer event: verify preconditions, check for a
   * new human-authored comment, enqueue a resume via `enqueueIfAbsent`.
   *
   * Returns true if enqueued, false if skipped or duplicate.
   */
  async processClarificationAnswerEvent(
    event: ClarificationAnswerEvent,
  ): Promise<boolean> {
    const { owner, repo, issueNumber, issueLabels, source } = event;

    const hasWaitingFor = issueLabels.includes(WAITING_FOR_CLARIFICATION_LABEL);
    const hasPaused = issueLabels.includes(AGENT_PAUSED_LABEL);
    if (!hasWaitingFor || !hasPaused) {
      this.logger.debug(
        { owner, repo, issueNumber, source, hasWaitingFor, hasPaused },
        'Precondition failed for clarification-answer enqueue (need waiting-for:clarification + agent:paused)',
      );
      return false;
    }

    const blockedLabel = issueLabels.find((l) => l.startsWith('blocked:'));
    if (blockedLabel) {
      this.logger.info(
        { owner, repo, issueNumber, blockedLabel, reason: 'blocked-label-present' },
        'Skipping clarification-answer enqueue while blocked:* label is present',
      );
      return false;
    }

    // Fetch comments and require ≥1 human-authored (viewerDidAuthor === false)
    // trusted comment. `viewerDidAuthor === true` comments (cluster-self) do
    // not count as "new human answer" — even if they carry the answer marker,
    // the phase loop is the source of truth for integrating cluster-relayed
    // answers, not the monitor.
    const client = this.createClient(undefined, this.tokenProvider);
    let comments;
    try {
      comments = await client.getIssueCommentsWithViewerAuth(owner, repo, issueNumber);
    } catch (err) {
      this.logger.warn(
        { err: String(err), owner, repo, issueNumber },
        'Failed to fetch comments during clarification-answer event — skipping',
      );
      return false;
    }

    const trustConfig = tryLoadCommentTrustConfig(process.cwd(), toEngineLogger(this.logger));
    const trustCtx: CommentTrustContext = {
      logger: toEngineLogger(this.logger),
      ...(this.clusterGithubUsername ? { botLogin: this.clusterGithubUsername } : {}),
      ...(trustConfig ? { config: trustConfig } : {}),
    };

    let hasHumanTrustedComment = false;
    for (const c of comments) {
      if (commentCarriesMachineMarker(c.body)) continue;
      const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx);
      if (decision.trusted) {
        hasHumanTrustedComment = true;
        break;
      }
    }

    if (!hasHumanTrustedComment) {
      this.logger.debug(
        { owner, repo, issueNumber },
        'No trusted human-authored comment found — nothing to resume on',
      );
      return false;
    }

    const workflowLabel = issueLabels.find((l) => l.startsWith('workflow:'));
    const workflowName = workflowLabel
      ? workflowLabel.slice('workflow:'.length)
      : 'speckit-feature';

    const queueItem: QueueItem = {
      owner,
      repo,
      issueNumber,
      workflowName,
      command: 'continue',
      priority: Date.now(),
      enqueuedAt: new Date().toISOString(),
      metadata: {},
      queueReason: 'resume',
    };

    const itemKey = `${owner}/${repo}#${issueNumber}`;
    const enqueued = await this.queueManager.enqueueIfAbsent(queueItem);
    if (!enqueued) {
      this.logger.info(
        { itemKey, reason: 'in-flight', owner, repo, issueNumber },
        'Dropping clarification-answer enqueue (item already in flight)',
      );
      return false;
    }

    this.logger.info(
      {
        event: 'clarification-answer-resume-enqueued',
        owner,
        repo,
        issueNumber,
        source,
      },
      'Clarification-answer resume enqueued',
    );
    return true;
  }

  // ==========================================================================
  // Polling
  // ==========================================================================

  async startPolling(): Promise<void> {
    if (this.state.isPolling) {
      this.logger.warn('Clarification-answer monitor polling already running');
      return;
    }

    const ac = new AbortController();
    this.abortController = ac;
    this.state.isPolling = true;
    this.logger.info(
      { intervalMs: this.state.currentPollIntervalMs, repos: this.options.repositories.length },
      'Starting clarification-answer monitor polling',
    );

    while (!ac.signal.aborted) {
      try {
        await this.poll();
      } catch (error) {
        this.logger.error(
          { err: error },
          'Error during clarification-answer poll cycle',
        );
      }

      if (this.options.adaptivePolling) {
        this.updateAdaptivePolling();
      }

      await this.sleep(this.state.currentPollIntervalMs, ac.signal);
    }

    this.state.isPolling = false;
    this.logger.info('Clarification-answer monitor polling loop stopped');
  }

  stopPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.logger.info('Clarification-answer monitor polling stop requested');
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

  private async pollRepo(owner: string, repo: string): Promise<void> {
    const client = this.createClient(undefined, this.tokenProvider);

    let allIssues;
    try {
      allIssues = await client.listIssuesWithLabel(
        owner,
        repo,
        WAITING_FOR_CLARIFICATION_LABEL,
      );
      if (this.githubAppCredentialId) {
        this.authHealth.recordResult(this.githubAppCredentialId, { ok: true });
      }
    } catch (error) {
      if (error instanceof JitTokenError) {
        this.logger.warn(
          { code: error.code, message: error.message, owner, repo },
          'JIT GitHub token refresh failed — skipping clarification-answer monitor cycle',
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
          {
            credentialId: this.githubAppCredentialId,
            statusCode: error.statusCode,
            owner,
            repo,
          },
          'GitHub authentication failing on clarification-answer monitor — investigate credential refresh chain',
        );
        return;
      }
      this.logger.warn(
        { err: String(error), owner, repo },
        'Error polling repository for clarification-answer pauses',
      );
      return;
    }

    const issues = filterByAssignee(allIssues, this.clusterGithubUsername, this.logger);

    if (issues.length === 0) {
      this.logger.debug(
        { owner, repo },
        'No clarification-answer pauses found this cycle',
      );
      return;
    }

    this.logger.info(
      { owner, repo, count: issues.length },
      'Clarification-answer pauses found',
    );

    for (const issue of issues) {
      const event: ClarificationAnswerEvent = {
        owner,
        repo,
        issueNumber: issue.number,
        issueLabels: issue.labels.map((l) => l.name),
        source: 'poll',
      };
      try {
        await this.processClarificationAnswerEvent(event);
      } catch (err) {
        this.logger.warn(
          { err: String(err), owner, repo, issueNumber: issue.number },
          'Error processing clarification-answer event — continuing to next issue',
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
        'Webhook reconnected, restoring clarification-answer monitor poll interval',
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
        'Webhooks appear unhealthy, increasing clarification-answer poll frequency',
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
 * Simple semaphore for bounded concurrency. Copy of the merge-conflict
 * monitor's helper — deliberately duplicated to keep the two monitors
 * shape-parallel and diffable.
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
