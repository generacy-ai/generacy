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
import type { GitHubWebhookPayload } from '../types/index.js';

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
  /**
   * Base delay before reconnecting after disconnect (ms).
   * Uses exponential backoff: 5s → 10s → 20s → 40s → 80s → 160s → 300s (capped).
   * Resets to base delay on successful connection.
   * @default 5000
   */
  baseReconnectDelayMs?: number;
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
  private readonly baseReconnectDelayMs: number;
  private abortController: AbortController | null = null;
  private running = false;
  private reconnectAttempt = 0;

  constructor(
    private readonly logger: Logger,
    private readonly monitorService: LabelMonitorService,
    options: SmeeReceiverOptions,
  ) {
    this.channelUrl = options.channelUrl;
    this.watchedRepos = options.watchedRepos;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? SmeeWebhookReceiver.BASE_RECONNECT_DELAY_MS;
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
      try {
        await this.connect(signal);
        // Reset backoff counter on successful connection
        this.reconnectAttempt = 0;
      } catch (error) {
        if (signal.aborted) break;
        const reconnectMs = this.reconnectDelayMs;
        this.logger.warn(
          { err: String(error), reconnectMs, attempt: this.reconnectAttempt },
          'Smee connection lost, reconnecting...',
        );

        // Increment attempt counter for exponential backoff
        this.reconnectAttempt++;
      }

      // Wait before reconnecting
      if (this.running && !signal.aborted) {
        await this.sleep(this.reconnectDelayMs, signal);
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

    if (!body || githubEvent !== 'issues') {
      return; // Only interested in issue events
    }

    const payload = body as unknown as GitHubWebhookPayload;

    // Only handle "labeled" action
    if (payload.action !== 'labeled') return;

    // Check if this is a watched repository
    if (!payload.repository?.owner?.login || !payload.repository?.name) return;
    const repoKey = `${payload.repository.owner.login}/${payload.repository.name}`;
    if (!this.watchedRepos.has(repoKey)) return;

    // Parse and process the label event
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
        this.monitorService.recordWebhookEvent();
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

    // Record webhook event for adaptive polling health tracking
    this.monitorService.recordWebhookEvent();

    // Process the event
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
