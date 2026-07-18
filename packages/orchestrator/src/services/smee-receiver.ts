/**
 * Smee.io webhook receiver for GitHub events.
 *
 * Connects to a smee.io channel URL via Server-Sent Events (SSE) using
 * the native fetch API. Receives GitHub webhook payloads forwarded by
 * smee.io and feeds them into the LabelMonitorService for processing.
 *
 * This eliminates the need for polling when a smee channel is configured,
 * providing near-instant label event detection with zero GitHub API calls.
 */
import type { LabelMonitorService } from './label-monitor-service.js';
import type { PrFeedbackMonitorService } from './pr-feedback-monitor-service.js';
import type { MergeConflictMonitorService } from './merge-conflict-monitor-service.js';
import type {
  ClarificationAnswerEvent,
  ClarificationAnswerMonitorService,
} from './clarification-answer-monitor-service.js';
import type { GitHubWebhookPayload } from '../types/index.js';
import type { PrReviewEvent } from '../types/monitor.js';

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface SmeeReceiverOptions {
  /** The smee.io channel URL */
  channelUrl: string;
  /** Set of "owner/repo" strings to filter events */
  watchedRepos: Set<string>;
  /** Cluster's GitHub username for assignee-based filtering */
  clusterGithubUsername?: string;
  /**
   * Base delay before reconnecting after disconnect (ms).
   * Uses exponential backoff: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped).
   * Resets to base delay on successful connection.
   * @default 5000
   */
  baseReconnectDelayMs?: number;
  /**
   * #987: called exactly once, after the first successful SSE connect
   * (immediately after the `Connected to smee.io channel` log line).
   * Subsequent reconnects do NOT re-invoke. Callers use this to flip
   * `webhooksConfigured=true` on the constructed monitors.
   */
  onConnected?: () => void;
  /**
   * #987 FR-004: sibling monitor refs for broad `recordWebhookEvent()`
   * fan-out. On every inbound event whose repo matches `watchedRepos`,
   * the receiver calls `recordWebhookEvent()` on each provided monitor.
   * Per-event processing dispatch fires only where the receiver has a
   * natural entry point (see contracts/smee-receiver-contract.md).
   */
  prFeedbackMonitor?: PrFeedbackMonitorService;
  mergeConflictMonitor?: MergeConflictMonitorService;
  clarificationAnswerMonitor?: ClarificationAnswerMonitorService;
}

/**
 * Receives GitHub webhook events from a smee.io channel via SSE.
 * Feeds label events directly into the LabelMonitorService.
 */
export class SmeeWebhookReceiver {
  private static readonly BASE_RECONNECT_DELAY_MS = 5000;
  private static readonly MAX_BACKOFF_MS = 300000; // 5 minutes

  private readonly channelUrl: string;
  private readonly watchedRepos: Set<string>;
  private readonly clusterGithubUsername: string | undefined;
  private readonly baseReconnectDelayMs: number;
  private readonly onConnected: (() => void) | undefined;
  private readonly prFeedbackMonitor: PrFeedbackMonitorService | undefined;
  private readonly mergeConflictMonitor: MergeConflictMonitorService | undefined;
  private readonly clarificationAnswerMonitor: ClarificationAnswerMonitorService | undefined;
  private abortController: AbortController | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private connectedOnceFired = false;

  constructor(
    private readonly logger: Logger,
    private readonly monitorService: LabelMonitorService,
    options: SmeeReceiverOptions,
  ) {
    this.channelUrl = options.channelUrl;
    this.watchedRepos = options.watchedRepos;
    this.clusterGithubUsername = options.clusterGithubUsername;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? SmeeWebhookReceiver.BASE_RECONNECT_DELAY_MS;
    this.onConnected = options.onConnected;
    this.prFeedbackMonitor = options.prFeedbackMonitor;
    this.mergeConflictMonitor = options.mergeConflictMonitor;
    this.clarificationAnswerMonitor = options.clarificationAnswerMonitor;
  }

  /**
   * Start listening to the smee.io channel.
   * Automatically reconnects on disconnect.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Smee receiver already running');
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    this.logger.info(
      { channelUrl: this.channelUrl, watchedRepos: [...this.watchedRepos] },
      'Starting smee.io webhook receiver',
    );

    while (this.running && !signal.aborted) {
      let sleepMs = this.reconnectDelayMs;
      try {
        await this.connect(signal);
        // Reset backoff counter on successful connection
        this.reconnectAttempt = 0;
        sleepMs = this.reconnectDelayMs;
      } catch (error) {
        if (signal.aborted) break;
        sleepMs = this.reconnectDelayMs;
        this.logger.warn(
          { err: String(error), reconnectMs: sleepMs, attempt: this.reconnectAttempt },
          'Smee connection lost, reconnecting...',
        );

        // Increment attempt counter for exponential backoff
        this.reconnectAttempt++;
      }

      // Wait before reconnecting (uses delay captured before attempt increment)
      if (this.running && !signal.aborted) {
        await this.sleep(sleepMs, signal);
      }
    }

    this.running = false;
    this.logger.info('Smee receiver stopped');
  }

  /**
   * Stop the receiver.
   */
  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.logger.info('Smee receiver stop requested');
  }

  /**
   * Connect to the smee.io channel and process events.
   */
  private async connect(signal: AbortSignal): Promise<void> {
    const response = await fetch(this.channelUrl, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });

    if (!response.ok) {
      throw new Error(`Smee connection failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Smee response has no body');
    }

    this.logger.info('Connected to smee.io channel');

    // #987: fire the `onConnected` callback exactly once per receiver instance.
    // Subsequent reconnects do NOT re-invoke — the setter is idempotent, but
    // firing once is semantically clearer.
    if (!this.connectedOnceFired) {
      this.connectedOnceFired = true;
      if (this.onConnected) {
        try {
          this.onConnected();
        } catch (error) {
          this.logger.warn(
            { err: String(error) },
            'onConnected callback threw; continuing',
          );
        }
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        const events = buffer.split('\n\n');
        // Keep the last incomplete chunk in the buffer
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          if (!eventBlock.trim()) continue;
          await this.processSSEEvent(eventBlock);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse and process a single SSE event block from smee.io.
   *
   * Smee.io SSE events have the format:
   *   event: message
   *   data: {"body": <webhook-payload>, "x-github-event": "issues", ...}
   */
  private async processSSEEvent(eventBlock: string): Promise<void> {
    let eventType = '';
    const dataLines: string[] = [];

    for (const line of eventBlock.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }

    // Only process message events
    if (eventType !== 'message' && eventType !== '') {
      // Smee sends 'ready' and 'ping' events — ignore them
      return;
    }

    const dataStr = dataLines.join('\n');
    if (!dataStr) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return; // Skip malformed events
    }

    // Smee wraps the webhook payload in a 'body' field
    const githubEvent = data['x-github-event'] as string | undefined;
    const body = data['body'] as Record<string, unknown> | undefined;
    if (!body) return;

    // Extract repository once — every supported webhook family carries this
    // block. Missing/malformed → drop before any monitor call.
    const repository = body['repository'] as
      | { owner?: { login?: string }; name?: string }
      | undefined;
    if (!repository?.owner?.login || !repository.name) return;
    const owner = repository.owner.login;
    const repo = repository.name;
    const repoKey = `${owner}/${repo}`;
    if (!this.watchedRepos.has(repoKey)) return;

    // #987 FR-004: broad `recordWebhookEvent()` fan-out. Fires before any
    // per-event processing dispatch so a processing error doesn't disable
    // adaptive-poll health tracking. Unconditional on `x-github-event` type —
    // the staleness safety net only needs `lastWebhookEvent` to be non-null.
    this.monitorService.recordWebhookEvent();
    this.prFeedbackMonitor?.recordWebhookEvent();
    this.mergeConflictMonitor?.recordWebhookEvent();
    this.clarificationAnswerMonitor?.recordWebhookEvent();

    const action = body['action'] as string | undefined;

    // Per-event processing dispatch.
    if (githubEvent === 'issues' && action === 'labeled') {
      await this.dispatchIssueLabeled(body as unknown as GitHubWebhookPayload, repoKey);
      return;
    }
    if (
      (githubEvent === 'pull_request_review' && action === 'submitted')
      || (githubEvent === 'pull_request_review_comment' && action === 'created')
    ) {
      this.dispatchPrReviewLike(body, owner, repo, repoKey, githubEvent);
      return;
    }
    if (githubEvent === 'issue_comment' && action === 'created') {
      this.dispatchIssueCommentCreated(body, owner, repo, repoKey);
      return;
    }
    // Any other event type: fan-out already fired above, no per-event dispatch.
  }

  /**
   * Handle `issues.labeled` — existing label-monitor path. `recordWebhookEvent`
   * has already been fired by the caller's fan-out.
   */
  private async dispatchIssueLabeled(
    payload: GitHubWebhookPayload,
    repoKey: string,
  ): Promise<void> {
    // Assignee filtering: only process issues assigned to this cluster
    if (this.clusterGithubUsername) {
      const assigneeLogins = (payload.issue?.assignees ?? []).map(a => a.login);
      if (assigneeLogins.length === 0) {
        this.logger.warn(
          { issue: payload.issue.number, repo: repoKey },
          'Smee: skipping issue with no assignees',
        );
        return;
      }
      if (!assigneeLogins.includes(this.clusterGithubUsername)) {
        this.logger.info(
          { issue: payload.issue.number, repo: repoKey, assignees: assigneeLogins },
          'Smee: skipping issue not assigned to this cluster',
        );
        return;
      }
    }

    const issueLabels = payload.issue?.labels?.map(l => l.name) ?? [];
    const event = this.monitorService.parseLabelEvent(
      payload.label.name,
      payload.repository.owner.login,
      payload.repository.name,
      payload.issue.number,
      issueLabels,
      'webhook',
    );

    if (!event) {
      // If this was a completed:* label that didn't match a waiting-for:*
      // in the webhook payload, re-fetch from GitHub to handle stale payloads.
      if (payload.label.name.startsWith('completed:')) {
        this.logger.info(
          { label: payload.label.name, repo: repoKey, issue: payload.issue.number },
          'Webhook completed:* label has no matching waiting-for:* in payload, attempting re-fetch',
        );
        try {
          await this.monitorService.verifyAndProcessCompletedLabel(
            payload.repository.owner.login,
            payload.repository.name,
            payload.issue.number,
            payload.label.name,
          );
        } catch (error) {
          this.logger.error(
            { err: String(error), repo: repoKey, issue: payload.issue.number },
            'Error during completed:* label re-fetch verification',
          );
        }
      }
      return;
    }

    this.logger.info(
      {
        type: event.type,
        repo: repoKey,
        issue: event.issueNumber,
        label: event.labelName,
      },
      'Smee webhook received label event',
    );

    try {
      await this.monitorService.processLabelEvent(event);
    } catch (error) {
      this.logger.error(
        { err: String(error), repo: repoKey, issue: event.issueNumber },
        'Error processing smee webhook event',
      );
    }
  }

  /**
   * Handle `pull_request_review.submitted` / `pull_request_review_comment.created`
   * — dispatch to the PR-feedback monitor. Assignee filter is NOT applied here;
   * `PrFeedbackMonitorService.processPrReviewEvent` performs its own PR-link +
   * assignee resolution.
   */
  private dispatchPrReviewLike(
    body: Record<string, unknown>,
    owner: string,
    repo: string,
    repoKey: string,
    githubEvent: string,
  ): void {
    const monitor = this.prFeedbackMonitor;
    if (!monitor) return;
    const pr = body['pull_request'] as
      | { number?: number; body?: string | null; head?: { ref?: string } }
      | undefined;
    if (!pr?.number || !pr.head?.ref) {
      this.logger.warn(
        { repo: repoKey, githubEvent },
        'Smee: skipping PR-review event without pull_request.number / head.ref',
      );
      return;
    }
    const event: PrReviewEvent = {
      owner,
      repo,
      prNumber: pr.number,
      prBody: pr.body ?? '',
      branchName: pr.head.ref,
      source: 'webhook',
    };
    monitor.processPrReviewEvent(event).catch((error) => {
      this.logger.error(
        { err: String(error), repo: repoKey, pr: pr.number, githubEvent },
        'Error processing smee PR-review event',
      );
    });
  }

  /**
   * Handle `issue_comment.created` — dispatch to the clarification-answer
   * monitor after the assignee filter (mirrors the label-event pattern).
   */
  private dispatchIssueCommentCreated(
    body: Record<string, unknown>,
    owner: string,
    repo: string,
    repoKey: string,
  ): void {
    const monitor = this.clarificationAnswerMonitor;
    if (!monitor) return;
    const issue = body['issue'] as
      | {
          number?: number;
          labels?: Array<{ name: string }>;
          assignees?: Array<{ login: string }>;
        }
      | undefined;
    if (!issue?.number) return;
    const assignees = issue.assignees ?? [];
    if (this.clusterGithubUsername) {
      const assigneeLogins = assignees.map(a => a.login);
      if (assigneeLogins.length === 0) {
        this.logger.warn(
          { issue: issue.number, repo: repoKey },
          'Smee: skipping issue_comment event on issue with no assignees',
        );
        return;
      }
      if (!assigneeLogins.includes(this.clusterGithubUsername)) {
        this.logger.info(
          { issue: issue.number, repo: repoKey, assignees: assigneeLogins },
          'Smee: skipping issue_comment event on issue not assigned to this cluster',
        );
        return;
      }
    }
    const issueLabels = (issue.labels ?? []).map(l => l.name);
    const event: ClarificationAnswerEvent = {
      owner,
      repo,
      issueNumber: issue.number,
      issueLabels,
      source: 'poll',
    };
    monitor.processClarificationAnswerEvent(event).catch((error) => {
      this.logger.error(
        { err: String(error), repo: repoKey, issue: issue.number },
        'Error processing smee issue_comment event',
      );
    });
  }

  /**
   * Get the current reconnect delay based on the number of attempts.
   * Uses exponential backoff with the current attempt count.
   */
  private get reconnectDelayMs(): number {
    return this.calculateBackoffDelay(this.reconnectAttempt);
  }

  /**
   * Calculate exponential backoff delay for reconnection attempts.
   * Formula: BASE_RECONNECT_DELAY_MS * 2^attempt, capped at MAX_BACKOFF_MS.
   * Progression: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped).
   *
   * @param attempt - The current reconnection attempt number (0-indexed)
   * @returns Delay in milliseconds before next reconnection attempt
   */
  private calculateBackoffDelay(attempt: number): number {
    const delay = this.baseReconnectDelayMs * Math.pow(2, attempt);
    return Math.min(delay, SmeeWebhookReceiver.MAX_BACKOFF_MS);
  }

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
