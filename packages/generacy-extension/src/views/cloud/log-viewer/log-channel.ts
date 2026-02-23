/**
 * Job Log Channel - Output channel for viewing and streaming remote job logs.
 *
 * Creates a VS Code output channel per job that displays historical logs
 * fetched via REST and streams live log lines via SSE subscription.
 * Reuses existing channels for the same job to avoid duplicates.
 *
 * Follows the same pattern as AgentLogChannel (views/cloud/agents/log-channel.ts).
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { queueApi } from '../../../api/endpoints/queue';
import { SSESubscriptionManager } from '../../../api/sse';
import type { JobLogLine, SSEEvent } from '../../../api/types';

/** Maximum number of historical log lines to fetch */
const HISTORICAL_LOG_LIMIT = 10_000;

/** Maximum retry attempts for historical log fetch */
const MAX_RETRIES = 3;

/** Retry backoff delays in milliseconds (5s, 10s, 20s) */
const RETRY_DELAYS = [5_000, 10_000, 20_000];

/** Step separator line width */
const SEPARATOR_WIDTH = 60;

/**
 * Manages a VS Code OutputChannel for a specific remote job, combining
 * historical log fetching with live SSE-based log streaming.
 */
export class JobLogChannel implements vscode.Disposable {
  /** Active channels by job ID — reuse existing channel for same job */
  private static activeChannels: Map<string, JobLogChannel> = new Map();

  private readonly outputChannel: vscode.OutputChannel;
  private readonly jobId: string;
  private readonly workflowName: string;
  private sseDisposable: vscode.Disposable | undefined;
  private disposed = false;
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(jobId: string, workflowName: string) {
    this.jobId = jobId;
    this.workflowName = workflowName;
    this.outputChannel = vscode.window.createOutputChannel(
      `Job: ${workflowName} (${jobId.slice(0, 8)})`
    );
  }

  /**
   * Open (or reuse) a job log channel, fetch historical logs,
   * subscribe to SSE for live streaming, and show the output channel.
   */
  async open(): Promise<void> {
    this.retryCount = 0;

    this.outputChannel.clear();
    this.outputChannel.appendLine(
      `--- Logs for ${this.workflowName} (${this.jobId.slice(0, 8)}) ---`
    );
    this.outputChannel.appendLine('');

    // Fetch historical logs and get cursor for SSE handoff
    const cursor = await this.fetchHistoricalLogs();

    this.outputChannel.appendLine('');
    this.outputChannel.appendLine('--- Live log stream active ---');
    this.outputChannel.appendLine('');

    // Subscribe to SSE for live log lines
    this.subscribeToSSE(cursor);

    // Show the output channel
    this.outputChannel.show(true);
  }

  /**
   * Fetch historical log lines from the REST API.
   * Returns the cursor for zero-gap SSE handoff.
   */
  private async fetchHistoricalLogs(): Promise<string | undefined> {
    try {
      const response = await queueApi.getJobLogs(this.jobId, { limit: HISTORICAL_LOG_LIMIT });

      if (response.lines.length === 0) {
        this.outputChannel.appendLine('Waiting for job to start...');
        return response.cursor;
      }

      if (response.truncated) {
        this.outputChannel.appendLine(
          `--- Showing last ${response.lines.length} of ${response.total} lines ---`
        );
        this.outputChannel.appendLine('');
      }

      for (const line of response.lines) {
        this.outputChannel.appendLine(this.formatLogLine(line));
      }

      this.outputChannel.appendLine('');
      this.outputChannel.appendLine(
        `--- ${response.lines.length} of ${response.total} historical lines ---`
      );

      return response.cursor;
    } catch (error) {
      this.handleFetchError(error);
      return undefined;
    }
  }

  /**
   * Subscribe to SSE jobs channel, filtering events for this job.
   * Routes events to appropriate handlers based on event type.
   */
  private subscribeToSSE(cursor?: string): void {
    // Clean up previous subscription if any
    this.sseDisposable?.dispose();

    const sseManager = SSESubscriptionManager.getInstance();

    // Note: cursor is available for server-side filtering via Last-Event-ID;
    // the SSESubscriptionManager handles this at the connection level.
    void cursor;

    this.sseDisposable = sseManager.subscribe('jobs', (event: SSEEvent) => {
      if (this.disposed) {
        return;
      }

      const eventData = event.data as Record<string, unknown> | undefined;
      if (!eventData) {
        return;
      }

      // Only process events for this job
      if (eventData.jobId !== this.jobId) {
        return;
      }

      switch (event.event) {
        case 'job:log':
          this.handleLogEvent(eventData);
          break;
        case 'job:step-start':
          this.handleStepBoundary(eventData);
          break;
        case 'job:log:end':
          this.handleJobEnd(eventData);
          break;
      }
    });
  }

  /**
   * Handle a job:log event — append the formatted log line.
   */
  private handleLogEvent(data: Record<string, unknown>): void {
    const line: JobLogLine = {
      content: typeof data.content === 'string' ? data.content : String(data.content ?? ''),
      stream: data.stream === 'stderr' ? 'stderr' : 'stdout',
      timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
      stepName: typeof data.stepName === 'string' ? data.stepName : undefined,
    };
    this.outputChannel.appendLine(this.formatLogLine(line));
  }

  /**
   * Handle a job:step-start event — insert a visual step separator.
   */
  private handleStepBoundary(data: Record<string, unknown>): void {
    const stepName = typeof data.stepName === 'string' ? data.stepName : 'unknown';
    this.appendStepSeparator(stepName);
  }

  /**
   * Handle a job:log:end event — show terminal status and stop streaming.
   */
  private handleJobEnd(data: Record<string, unknown>): void {
    const status = typeof data.status === 'string' ? data.status : 'ended';
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine(`--- Job ${status} ---`);

    // Stop listening for further events
    this.sseDisposable?.dispose();
    this.sseDisposable = undefined;
  }

  /**
   * Format a log line with timestamp and stream indicator.
   * Stderr lines are prefixed with [ERR] for visual distinction.
   */
  private formatLogLine(line: JobLogLine): string {
    const time = new Date(line.timestamp).toLocaleTimeString();
    const streamPrefix = line.stream === 'stderr' ? '[ERR] ' : '';
    return `[${time}] ${streamPrefix}${line.content}`;
  }

  /**
   * Append a visual step separator to the output channel.
   */
  private appendStepSeparator(stepName: string): void {
    const label = ` Step: ${stepName} `;
    const sideLen = Math.max(0, Math.floor((SEPARATOR_WIDTH - label.length) / 2));
    const separator = '─'.repeat(sideLen) + label + '─'.repeat(sideLen);
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine(separator);
    this.outputChannel.appendLine('');
  }

  /**
   * Handle a historical log fetch error with retry logic.
   * Retries up to MAX_RETRIES times with increasing backoff.
   */
  private handleFetchError(error: unknown): void {
    const logger = getLogger();
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error(`Failed to fetch logs for job ${this.jobId}`, error);

    if (this.retryCount < MAX_RETRIES) {
      const delay = RETRY_DELAYS[this.retryCount]!;
      this.retryCount++;
      this.outputChannel.appendLine(
        `Failed to load historical logs: ${errorMessage}`
      );
      this.outputChannel.appendLine(
        `Retrying in ${delay / 1000}s (attempt ${this.retryCount}/${MAX_RETRIES})...`
      );

      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.disposed) {
          void this.fetchHistoricalLogs();
        }
      }, delay);
    } else {
      this.outputChannel.appendLine(
        `Failed to load historical logs after ${MAX_RETRIES} attempts: ${errorMessage}`
      );
    }
  }

  /**
   * Dispose of the output channel and SSE subscription.
   * Removes this channel from the active channels map.
   */
  dispose(): void {
    this.disposed = true;
    this.sseDisposable?.dispose();
    this.sseDisposable = undefined;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.outputChannel.dispose();
    JobLogChannel.activeChannels.delete(this.jobId);
  }

  /**
   * Open job logs in an output channel with historical + live streaming.
   * Reuses an existing channel for the same job if one is already open.
   */
  static async openJobLogs(jobId: string, workflowName: string): Promise<void> {
    const logger = getLogger();
    logger.info(`Opening log channel for job: ${jobId} (${workflowName})`);

    // Reuse existing channel for this job
    let channel = JobLogChannel.activeChannels.get(jobId);
    if (channel) {
      // Re-open: refresh logs and show
      await channel.open();
      return;
    }

    // Create new channel
    channel = new JobLogChannel(jobId, workflowName);
    JobLogChannel.activeChannels.set(jobId, channel);

    await channel.open();
  }

  /**
   * Dispose all active job log channels.
   * Useful for extension deactivation cleanup.
   */
  static disposeAll(): void {
    for (const channel of JobLogChannel.activeChannels.values()) {
      channel.dispose();
    }
    JobLogChannel.activeChannels.clear();
  }
}
