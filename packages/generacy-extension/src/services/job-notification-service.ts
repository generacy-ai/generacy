/**
 * Job Notification Service for cloud workflow terminal events.
 *
 * Subscribes to SSE `queue:updated` events and surfaces VS Code notifications
 * when jobs reach terminal states (completed, failed, cancelled). Includes:
 * - Event deduplication via bounded ID set (100 entries, FIFO eviction)
 * - Configuration-driven suppression (notifications.enabled, onComplete, onError)
 * - Data enrichment via JobProgress API (PR URL, failed step details)
 * - Rate limiting: 3+ notifications in 10s → single summary
 * - Focus batching: queue notifications while VS Code is unfocused
 * - continueOnError inference: step failures without terminal event → status bar only
 */
import * as vscode from 'vscode';
import { SSESubscriptionManager } from '../api/sse';
import { queueApi } from '../api/endpoints/queue';
import type { SSEEvent, QueueItem, JobProgress, WorkflowStepEventData } from '../api/types';
import { CloudJobStatusBarProvider } from '../providers/status-bar';
import type { QueueTreeProvider } from '../views/cloud/queue';
import { CONFIG_KEYS, CLOUD_COMMANDS } from '../constants';
import { getLogger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

/** Terminal job statuses that trigger notifications */
type TerminalStatus = 'completed' | 'failed' | 'cancelled';

/** A notification waiting to be displayed (used for rate limiting and focus batching) */
interface PendingNotification {
  queueItem: QueueItem;
  status: TerminalStatus;
  progress?: JobProgress;
  timestamp: number;
}

/** Config section for reading settings */
const CONFIG_SECTION = 'generacy';

/** Maximum number of seen event IDs to retain for deduplication */
const MAX_SEEN_IDS = 100;

/** Rate limit batch window in milliseconds */
const BATCH_WINDOW_MS = 10_000;

/** Threshold for grouping notifications into a summary */
const BATCH_THRESHOLD = 3;

/** Delay before treating a step failure as continueOnError (ms) */
const CONTINUE_ON_ERROR_WINDOW_MS = 5_000;

// ============================================================================
// JobNotificationService
// ============================================================================

export class JobNotificationService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  // --- Deduplication ---
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventIdOrder: string[] = [];

  // --- Rate limiting ---
  private pendingNotifications: PendingNotification[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;

  // --- Focus batching ---
  private unfocusedQueue: PendingNotification[] = [];
  private isFocused: boolean;

  // --- continueOnError tracking ---
  /** Maps jobId → timer that fires if no terminal event arrives */
  private readonly stepFailureTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cloudStatusBar: CloudJobStatusBarProvider,
    _queueProvider: QueueTreeProvider,
    _extensionUri: vscode.Uri,
  ) {
    this.isFocused = vscode.window.state.focused;

    this.subscribeSSE();
    this.subscribeFocusState();
  }

  // ==========================================================================
  // Disposable
  // ==========================================================================

  public dispose(): void {
    this.disposed = true;
    this.clearBatchTimer();
    this.pendingNotifications = [];
    this.unfocusedQueue = [];

    for (const timer of this.stepFailureTimers.values()) {
      clearTimeout(timer);
    }
    this.stepFailureTimers.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  // ==========================================================================
  // SSE Subscription
  // ==========================================================================

  private subscribeSSE(): void {
    const sseManager = SSESubscriptionManager.getInstance();

    // Subscribe to queue channel for terminal status events
    this.disposables.push(
      sseManager.subscribe('queue', (event) => this.handleQueueEvent(event)),
    );

    // Subscribe to workflows channel for step-level failure events (continueOnError)
    this.disposables.push(
      sseManager.subscribe('workflows', (event) => this.handleWorkflowEvent(event)),
    );
  }

  private subscribeFocusState(): void {
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        const wasFocused = this.isFocused;
        this.isFocused = state.focused;

        if (wasFocused && !state.focused) {
          // On focus loss: move any pending batch notifications into the
          // unfocused queue so they don't fire while VS Code is in the
          // background. Cancel the batch timer since those notifications
          // will be flushed on refocus instead.
          if (this.pendingNotifications.length > 0) {
            this.unfocusedQueue.push(...this.pendingNotifications);
            this.pendingNotifications = [];
            this.clearBatchTimer();
          }
        } else if (!wasFocused && state.focused) {
          // On refocus, flush queued notifications
          this.flushUnfocusedQueue();
        }
      }),
    );
  }

  // ==========================================================================
  // Event Handling
  // ==========================================================================

  private handleQueueEvent(event: SSEEvent): void {
    if (this.disposed) return;

    // Only process queue:updated events
    if (event.event !== 'queue:updated') return;

    const data = event.data as Partial<QueueItem> & { id?: string; itemId?: string };
    const status = data.status;

    // Only process terminal statuses
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return;

    // Deduplication
    if (this.isDuplicate(event.id)) return;
    this.markSeen(event.id);

    // If a terminal event arrives for a job that had a pending step-failure timer,
    // clear the timer (it's not a continueOnError situation)
    const itemId = data.id ?? data.itemId;
    if (itemId) {
      this.clearStepFailureTimer(itemId);
    }

    // Build a partial QueueItem from the SSE data
    const queueItem: QueueItem = {
      id: itemId ?? event.id,
      workflowId: data.workflowId ?? '',
      workflowName: data.workflowName ?? 'Unknown workflow',
      status,
      priority: data.priority ?? 'normal',
      repository: data.repository,
      assigneeId: data.assigneeId,
      queuedAt: data.queuedAt ?? '',
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      error: data.error,
      progress: data.progress,
    };

    // Configuration check
    if (!this.shouldNotify(status)) return;

    // Flash the status bar regardless of notification batching
    this.cloudStatusBar.flash(status);

    // Enrich and notify
    void this.enrichAndNotify(queueItem, status);
  }

  private handleWorkflowEvent(event: SSEEvent): void {
    if (this.disposed) return;

    // Listen for step-level failures for continueOnError inference
    if (event.event !== 'workflow:step:complete') return;

    const data = event.data as WorkflowStepEventData;

    if (!data.jobId || data.step?.status !== 'failed') return;

    // Deduplicate workflow step events (SSE reconnect can replay)
    if (this.isDuplicate(event.id)) return;
    this.markSeen(event.id);

    // Start a timer: if no terminal queue:updated arrives within the window,
    // treat as continueOnError → flash status bar only (no toast)
    const jobId = data.jobId;

    // Clear any existing timer for this job (a new step failure supersedes the previous)
    this.clearStepFailureTimer(jobId);

    const timer = setTimeout(() => {
      this.stepFailureTimers.delete(jobId);
      // No terminal event arrived → this is a continueOnError step failure
      // Flash the status bar subtly, but no toast notification
      this.cloudStatusBar.flash('failed');
      const logger = getLogger();
      logger.debug(
        `continueOnError step failure for job ${jobId}, step "${data.step.name}" — status bar flash only`,
      );
    }, CONTINUE_ON_ERROR_WINDOW_MS);

    this.stepFailureTimers.set(jobId, timer);
  }

  // ==========================================================================
  // Deduplication
  // ==========================================================================

  private isDuplicate(eventId: string): boolean {
    return this.seenEventIds.has(eventId);
  }

  private markSeen(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventIdOrder.push(eventId);

    // Evict oldest when over limit
    while (this.seenEventIds.size > MAX_SEEN_IDS) {
      const oldest = this.seenEventIdOrder.shift();
      if (oldest !== undefined) {
        this.seenEventIds.delete(oldest);
      }
    }
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private shouldNotify(status: TerminalStatus): boolean {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

    const enabled = config.get<boolean>(CONFIG_KEYS.notificationsEnabled, true);
    if (!enabled) return false;

    if (status === 'completed') {
      return config.get<boolean>(CONFIG_KEYS.notificationsOnComplete, true);
    }

    // failed and cancelled are both governed by onError
    return config.get<boolean>(CONFIG_KEYS.notificationsOnError, true);
  }

  // ==========================================================================
  // Data Enrichment
  // ==========================================================================

  private async enrichAndNotify(queueItem: QueueItem, status: TerminalStatus): Promise<void> {
    const logger = getLogger();
    let progress: JobProgress | undefined;

    try {
      progress = await queueApi.getJobProgress(queueItem.id);
    } catch (err) {
      // Gracefully degrade: show notification without enrichment
      logger.debug(`Failed to fetch job progress for ${queueItem.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const pending: PendingNotification = {
      queueItem,
      status,
      progress,
      timestamp: Date.now(),
    };

    // If VS Code is unfocused, queue for later
    if (!this.isFocused) {
      this.unfocusedQueue.push(pending);
      return;
    }

    this.addToBatch(pending);
  }

  // ==========================================================================
  // Rate Limiting (Batch Window)
  // ==========================================================================

  private addToBatch(notification: PendingNotification): void {
    this.pendingNotifications.push(notification);

    if (this.batchTimer === undefined) {
      this.batchTimer = setTimeout(() => {
        this.batchTimer = undefined;
        this.flushBatch();
      }, BATCH_WINDOW_MS);
    }
  }

  private flushBatch(): void {
    if (this.disposed || this.pendingNotifications.length === 0) return;

    const batch = this.pendingNotifications;
    this.pendingNotifications = [];

    // If VS Code lost focus while the batch timer was running, move
    // notifications to the unfocused queue instead of displaying them.
    if (!this.isFocused) {
      this.unfocusedQueue.push(...batch);
      return;
    }

    if (batch.length >= BATCH_THRESHOLD) {
      this.showSummaryNotification(batch);
    } else {
      for (const n of batch) {
        this.showIndividualNotification(n);
      }
    }
  }

  // ==========================================================================
  // Focus Batching
  // ==========================================================================

  private flushUnfocusedQueue(): void {
    if (this.unfocusedQueue.length === 0) return;

    const queued = this.unfocusedQueue;
    this.unfocusedQueue = [];

    if (queued.length >= BATCH_THRESHOLD) {
      this.showSummaryNotification(queued);
    } else {
      for (const n of queued) {
        this.showIndividualNotification(n);
      }
    }
  }

  // ==========================================================================
  // Notification Display
  // ==========================================================================

  private showIndividualNotification(notification: PendingNotification): void {
    const { queueItem, status, progress } = notification;
    const name = queueItem.workflowName;
    const duration = this.computeDuration(queueItem);
    const durationStr = duration !== undefined ? ` (${this.formatDuration(duration)})` : '';

    switch (status) {
      case 'completed': {
        const prUrl = progress?.pullRequestUrl;
        const prInfo = prUrl ? this.extractPrInfo(prUrl) : undefined;
        const prLine = prInfo ? `\n→ PR #${prInfo.number}: ${prInfo.url}` : '';
        const message = `✅ ${name} completed${durationStr}${prLine}`;

        const actions: string[] = [];
        if (prUrl) actions.push('View PR');
        actions.push('View Details');

        void vscode.window.showInformationMessage(message, ...actions).then((action) => {
          this.handleNotificationAction(action, queueItem.id, prUrl);
        });
        break;
      }

      case 'failed': {
        const failedStep = this.findFailedStep(progress);
        const stepInfo = failedStep ? ` at step "${failedStep.name}"` : '';
        const errorDetail = failedStep?.error ?? queueItem.error;
        const errorLine = errorDetail ? `\n→ Error: ${errorDetail}` : '';
        const message = `❌ ${name} failed${stepInfo}${durationStr}${errorLine}`;

        void vscode.window.showWarningMessage(message, 'View Logs', 'View Details').then((action) => {
          this.handleNotificationAction(action, queueItem.id);
        });
        break;
      }

      case 'cancelled': {
        const message = `${name} was cancelled`;

        void vscode.window.showInformationMessage(message, 'View Details').then((action) => {
          this.handleNotificationAction(action, queueItem.id);
        });
        break;
      }
    }
  }

  private showSummaryNotification(notifications: PendingNotification[]): void {
    const counts = { completed: 0, failed: 0, cancelled: 0 };
    for (const n of notifications) {
      counts[n.status]++;
    }

    const parts: string[] = [];
    if (counts.completed > 0) {
      parts.push(`${counts.completed} job${counts.completed !== 1 ? 's' : ''} completed`);
    }
    if (counts.failed > 0) {
      parts.push(`${counts.failed} job${counts.failed !== 1 ? 's' : ''} failed`);
    }
    if (counts.cancelled > 0) {
      parts.push(`${counts.cancelled} job${counts.cancelled !== 1 ? 's' : ''} cancelled`);
    }

    const message = parts.join(', ');
    const hasFailures = counts.failed > 0;

    const showFn = hasFailures
      ? vscode.window.showWarningMessage
      : vscode.window.showInformationMessage;

    void showFn(message, 'View Queue').then((action) => {
      if (action === 'View Queue') {
        void vscode.commands.executeCommand(CLOUD_COMMANDS.focusQueue);
      }
    });
  }

  // ==========================================================================
  // Action Handling
  // ==========================================================================

  private handleNotificationAction(
    action: string | undefined,
    jobId: string,
    prUrl?: string,
  ): void {
    if (!action) return;

    switch (action) {
      case 'View PR':
        if (prUrl) {
          void vscode.env.openExternal(vscode.Uri.parse(prUrl));
        }
        break;
      case 'View Details':
      case 'View Logs':
        void vscode.commands.executeCommand(CLOUD_COMMANDS.viewJobProgress, jobId);
        break;
    }
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private computeDuration(item: QueueItem): number | undefined {
    if (!item.startedAt) return undefined;
    const start = new Date(item.startedAt).getTime();
    const end = item.completedAt
      ? new Date(item.completedAt).getTime()
      : Date.now();
    const duration = end - start;
    return duration > 0 ? duration : undefined;
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;

    if (minutes < 60) {
      return remainingSeconds > 0
        ? `${minutes}m ${remainingSeconds}s`
        : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  private findFailedStep(
    progress: JobProgress | undefined,
  ): { name: string; error?: string } | undefined {
    if (!progress) return undefined;

    for (const phase of progress.phases) {
      for (const step of phase.steps) {
        if (step.status === 'failed') {
          return { name: step.name, error: step.error };
        }
      }
      // Also check phase-level error
      if (phase.status === 'failed' && phase.error) {
        return { name: phase.name, error: phase.error };
      }
    }
    return undefined;
  }

  private extractPrInfo(prUrl: string): { number: string; url: string } | undefined {
    // Extract PR number from GitHub URL (e.g., https://github.com/owner/repo/pull/123)
    const match = prUrl.match(/\/pull\/(\d+)/);
    if (match) {
      return { number: match[1]!, url: prUrl };
    }
    return { number: '?', url: prUrl };
  }

  private clearStepFailureTimer(jobId: string): void {
    const timer = this.stepFailureTimers.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.stepFailureTimers.delete(jobId);
    }
  }

  private clearBatchTimer(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
  }
}
