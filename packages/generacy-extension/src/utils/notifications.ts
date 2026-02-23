/**
 * Notification manager for orchestration SSE events.
 *
 * Subscribes to all SSE channels and shows VS Code notifications based on the
 * user-configured notification level:
 * - 'all': show immediately for each event
 * - 'summary': batch events in a 10s window, then show a single summary
 * - 'none': suppress all notifications
 *
 * Listens for config changes to update behavior at runtime.
 */
import * as vscode from 'vscode';
import { SSESubscriptionManager } from '../api/sse';
import type { SSEEvent, SSEChannel } from '../api/types';
import { CLOUD_COMMANDS } from '../constants';
import { getLogger } from './logger';

// ============================================================================
// Types
// ============================================================================

/** Notification level controlling how orchestration events are surfaced */
export type NotificationLevel = 'all' | 'summary' | 'none';

/** Config key for the notification level setting */
const CONFIG_SECTION = 'generacy';
const NOTIFICATION_LEVEL_KEY = 'dashboard.notifications';
const DEFAULT_NOTIFICATION_LEVEL: NotificationLevel = 'summary';

/** Batch window duration for summary mode (milliseconds) */
const BATCH_WINDOW_MS = 10_000;

/** SSE channels to subscribe to */
const SUBSCRIBED_CHANNELS: SSEChannel[] = ['workflows', 'queue', 'agents'];

// ============================================================================
// Event Classification
// ============================================================================

/** Classify an SSE event type into a notification severity */
function getMessageLevel(eventType: string): 'info' | 'warning' {
  if (
    eventType.includes('failed') ||
    eventType.includes('error') ||
    eventType.includes('disconnected')
  ) {
    return 'warning';
  }
  return 'info';
}

/** Build a human-readable message for an individual SSE event */
function formatEventMessage(event: SSEEvent): string {
  // Use the event type as a readable label (e.g., "workflow:completed" → "Workflow completed")
  const label = event.event
    .replace(/:/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const data = event.data as Record<string, unknown> | undefined;
  const detail = data?.message ?? data?.name ?? data?.id;
  return detail ? `${label}: ${String(detail)}` : label;
}

// ============================================================================
// Notification Manager
// ============================================================================

/**
 * Manages VS Code notifications for orchestration SSE events.
 *
 * Usage:
 * ```typescript
 * const manager = new NotificationManager();
 * context.subscriptions.push(manager);
 * ```
 */
export class NotificationManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private pendingNotifications: SSEEvent[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor() {
    const sseManager = SSESubscriptionManager.getInstance();

    // Subscribe to all channels
    for (const channel of SUBSCRIBED_CHANNELS) {
      this.disposables.push(
        sseManager.subscribe(channel, (event) => this.handleEvent(event)),
      );
    }

    // Listen for config changes to react at runtime
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${CONFIG_SECTION}.${NOTIFICATION_LEVEL_KEY}`)) {
          this.onNotificationLevelChanged();
        }
      }),
    );
  }

  // ==========================================================================
  // Disposable
  // ==========================================================================

  public dispose(): void {
    this.disposed = true;
    this.clearBatchTimer();
    this.pendingNotifications = [];
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  // ==========================================================================
  // Private: Event Handling
  // ==========================================================================

  private handleEvent(event: SSEEvent): void {
    if (this.disposed) {
      return;
    }

    const level = this.getNotificationLevel();

    if (level === 'none') {
      return;
    }

    if (level === 'all') {
      this.showImmediate(event);
      return;
    }

    // 'summary' mode: batch events
    this.pendingNotifications.push(event);
    this.scheduleBatch();
  }

  // ==========================================================================
  // Private: Immediate Mode
  // ==========================================================================

  private showImmediate(event: SSEEvent): void {
    const message = formatEventMessage(event);
    const severity = getMessageLevel(event.event);

    if (severity === 'warning') {
      void vscode.window
        .showWarningMessage(message, 'Open Dashboard')
        .then((action) => this.handleAction(action));
    } else {
      void vscode.window
        .showInformationMessage(message, 'Open Dashboard')
        .then((action) => this.handleAction(action));
    }
  }

  // ==========================================================================
  // Private: Summary Mode (Batching)
  // ==========================================================================

  private scheduleBatch(): void {
    if (this.batchTimer !== undefined) {
      return;
    }

    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      this.flushBatch();
    }, BATCH_WINDOW_MS);
  }

  private flushBatch(): void {
    if (this.disposed || this.pendingNotifications.length === 0) {
      return;
    }

    const events = this.pendingNotifications;
    this.pendingNotifications = [];

    const summary = this.buildSummary(events);
    const hasWarnings = events.some((e) => getMessageLevel(e.event) === 'warning');

    if (hasWarnings) {
      void vscode.window
        .showWarningMessage(summary, 'Open Dashboard')
        .then((action) => this.handleAction(action));
    } else {
      void vscode.window
        .showInformationMessage(summary, 'Open Dashboard')
        .then((action) => this.handleAction(action));
    }
  }

  /**
   * Build a summary string from a batch of events.
   * Groups events by their broad category and counts them.
   * e.g. "3 workflows completed, 1 failed, 2 agents connected"
   */
  private buildSummary(events: SSEEvent[]): string {
    const counts = new Map<string, number>();

    for (const event of events) {
      const label = event.event.replace(/:/g, ' ');
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [label, count] of counts) {
      parts.push(`${count} ${label}`);
    }

    return parts.join(', ');
  }

  // ==========================================================================
  // Private: Helpers
  // ==========================================================================

  private handleAction(action: string | undefined): void {
    if (action === 'Open Dashboard') {
      void vscode.commands.executeCommand(CLOUD_COMMANDS.openDashboard);
    }
  }

  private getNotificationLevel(): NotificationLevel {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const value = config.get<string>(NOTIFICATION_LEVEL_KEY, DEFAULT_NOTIFICATION_LEVEL);

    // Validate the value is one of the expected levels
    if (value === 'all' || value === 'summary' || value === 'none') {
      return value;
    }

    return DEFAULT_NOTIFICATION_LEVEL;
  }

  /**
   * When the notification level changes, flush any pending batch (if switching
   * away from summary mode) and reset state.
   */
  private onNotificationLevelChanged(): void {
    const logger = getLogger();
    const newLevel = this.getNotificationLevel();
    logger.info(`Notification level changed to '${newLevel}'`);

    // If we're leaving summary mode, flush pending events
    if (newLevel !== 'summary') {
      this.clearBatchTimer();
      this.pendingNotifications = [];
    }
  }

  private clearBatchTimer(): void {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
  }
}
