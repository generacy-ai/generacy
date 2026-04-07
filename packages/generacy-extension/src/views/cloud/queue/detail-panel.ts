/**
 * JobDetailPanel - Webview panel for displaying job progress with live updates.
 *
 * Replaces the former WorkItemDetailPanel with real-time phase/step progress.
 *
 * Implements a singleton preview pattern with pinning support:
 * - A single unpinned preview panel is reused when selecting different items
 * - Pinning a panel preserves it and allows a new preview to open alongside
 * - SSE subscription on the `workflows` channel keeps progress up-to-date in real time
 * - Uses JobProgressState for snapshot/incremental merge of phase and step events
 * - Tiered debounce: phase events sent immediately, step events debounced at 200ms
 * - Polling fallback when SSE connection is lost
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { queueApi } from '../../../api/endpoints/queue';
import type { OrgCapacity } from '../../../api/endpoints/orgs';
import { getSSEManager } from '../../../api/sse';
import type { SSEConnectionState } from '../../../api/sse';
import type {
  QueueItem,
  QueueStatus,
  JobProgress,
  JobDetailWebviewMessage,
  JobDetailExtensionMessage,
  SSEEvent,
  WorkflowPhaseEventData,
  WorkflowStepEventData,
} from '../../../api/types';
import { CLOUD_COMMANDS } from '../../../constants';
import { JobProgressState } from './progress-state';
import { getJobDetailHtml } from './detail-html';
import { JobLogChannel } from '../log-viewer';

// ============================================================================
// Constants
// ============================================================================

/** Debounce delay for step events (ms) */
const STEP_DEBOUNCE_MS = 200;

/** Polling interval when SSE is disconnected (ms) */
const POLLING_FALLBACK_INTERVAL_MS = 5000;

/** Statuses that indicate a job is terminal (no live updates needed) */
const TERMINAL_STATUSES: QueueStatus[] = ['completed', 'failed', 'cancelled'];

// ============================================================================
// JobDetailPanel
// ============================================================================

/**
 * Webview panel for displaying detailed job progress with live phase/step updates.
 *
 * Supports a preview/pin workflow:
 * - `showPreview()` reuses an existing unpinned panel or creates a new one
 * - `pin()` freezes the current panel in place so subsequent selections open a fresh preview
 */
export class JobDetailPanel {
  /** The singleton unpinned preview instance */
  private static previewInstance: JobDetailPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private queueItem: QueueItem;
  private isPinned = false;
  private isDisposed = false;

  /** State manager for incremental progress merge */
  private readonly progressState: JobProgressState;

  /** Timer for debouncing step events */
  private stepDebounceTimer: ReturnType<typeof setTimeout> | undefined;

  /** Timer for polling fallback when SSE disconnects */
  private pollingFallbackTimer: ReturnType<typeof setInterval> | undefined;

  /** Whether the SSE connection is currently active */
  private isSSEConnected = true;

  /** Org execution capacity for slot-waiting indicator */
  private orgCapacity: OrgCapacity | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    item: QueueItem,
    progress: JobProgress | null,
    orgCapacity?: OrgCapacity
  ) {
    this.panel = panel;
    this.queueItem = item;
    this.orgCapacity = orgCapacity;
    this.progressState = new JobProgressState();

    if (progress) {
      this.progressState.applySnapshot(progress);
    }

    // Set initial HTML shell (the webview JS will receive data via postMessage)
    this.panel.webview.html = getJobDetailHtml({
      item,
      progress,
      expandedPhases: this.progressState.getExpandedPhases(),
      isPinned: this.isPinned,
      orgCapacity,
    });

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: JobDetailWebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    // Only subscribe to SSE for non-terminal jobs
    if (!TERMINAL_STATUSES.includes(item.status)) {
      this.subscribeSSE();
    }
  }

  // ==========================================================================
  // Static Factory
  // ==========================================================================

  /**
   * Show a preview panel for a queue item.
   *
   * - If an unpinned preview exists, it is reused with updated content.
   * - If no unpinned preview exists (or the current one is pinned), a new panel is created.
   * - Fetches both the queue item and progress data in parallel on creation.
   */
  public static showPreview(item: QueueItem, extensionUri: vscode.Uri, orgCapacity?: OrgCapacity): JobDetailPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    // Reuse existing unpinned preview
    if (JobDetailPanel.previewInstance && !JobDetailPanel.previewInstance.isDisposed) {
      const instance = JobDetailPanel.previewInstance;
      instance.switchToItem(item, orgCapacity);
      instance.panel.reveal(column);
      return instance;
    }

    // Create new panel
    const panel = vscode.window.createWebviewPanel(
      'generacy.queueItemDetail',
      `Queue: ${item.workflowName}`,
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')],
      }
    );

    panel.iconPath = new vscode.ThemeIcon('list-selection');

    const instance = new JobDetailPanel(panel, item, null, orgCapacity);
    JobDetailPanel.previewInstance = instance;

    // Kick off initial data loading
    void instance.loadInitialData();

    return instance;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Pin this panel so it is no longer reused by `showPreview()`.
   * The next `showPreview()` call will create a fresh panel.
   */
  public pin(): void {
    if (this.isPinned || this.isDisposed) {
      return;
    }

    this.isPinned = true;

    // Clear ourselves from the preview slot so the next selection opens a new panel
    if (JobDetailPanel.previewInstance === this) {
      JobDetailPanel.previewInstance = undefined;
    }

    // Update the title to indicate pinned state
    this.panel.title = `$(pin) Queue: ${this.queueItem.workflowName}`;

    const logger = getLogger();
    logger.debug(`Pinned detail panel for queue item: ${this.queueItem.id}`);
  }

  /**
   * Whether this panel is pinned.
   */
  public get pinned(): boolean {
    return this.isPinned;
  }

  /**
   * Get the currently displayed item.
   */
  public get item(): QueueItem {
    return this.queueItem;
  }

  /**
   * Get the singleton preview instance (if any).
   */
  public static getPreviewInstance(): JobDetailPanel | undefined {
    return JobDetailPanel.previewInstance;
  }

  // ==========================================================================
  // Content & Data Loading
  // ==========================================================================

  /**
   * Switch to displaying a different queue item.
   * Clears previous state, sets new content, and loads fresh data.
   */
  private switchToItem(item: QueueItem, orgCapacity?: OrgCapacity): void {
    // Clear previous subscriptions and timers
    this.clearTimers();
    this.disposeSubscriptions();

    this.queueItem = item;
    this.orgCapacity = orgCapacity;
    this.progressState.reset();

    this.panel.title = this.isPinned
      ? `$(pin) Queue: ${item.workflowName}`
      : `Queue: ${item.workflowName}`;

    // Generate fresh HTML
    this.panel.webview.html = getJobDetailHtml({
      item,
      progress: null,
      expandedPhases: this.progressState.getExpandedPhases(),
      isPinned: this.isPinned,
      orgCapacity: this.orgCapacity,
    });

    // Re-subscribe to SSE for the new item if not terminal
    if (!TERMINAL_STATUSES.includes(item.status)) {
      this.subscribeSSE();
    }

    // Load fresh data
    void this.loadInitialData();
  }

  /**
   * Load initial data by fetching item and progress in parallel.
   *
   * Sends a loading placeholder first, then fetches fresh data and sends
   * the full update with expanded phases. For terminal jobs (completed,
   * failed, cancelled), this is a one-shot static load with no SSE.
   */
  private async loadInitialData(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();
    const itemId = this.queueItem.id;

    // Send loading placeholder so the webview can show a loading state
    this.postMessage({
      type: 'update',
      data: {
        item: this.queueItem,
        progress: null,
      },
    });

    try {
      const [freshItem, progress] = await Promise.all([
        queueApi.getQueueItem(itemId).catch((error) => {
          logger.error(`Failed to fetch queue item: ${itemId}`, error);
          return this.queueItem; // Fallback to cached
        }),
        queueApi.getJobProgress(itemId).catch(() => {
          logger.debug(`No progress data available for: ${itemId}`);
          return null;
        }),
      ]);

      if (this.isDisposed || this.queueItem.id !== itemId) {
        return; // Panel disposed or switched to different item
      }

      this.queueItem = freshItem;

      if (progress) {
        this.progressState.applySnapshot(progress);
      }

      // Send full update with expanded phases set
      this.postMessage({
        type: 'update',
        data: {
          item: freshItem,
          progress: this.progressState.getProgress(),
          expandedPhases: [...this.progressState.getExpandedPhases()],
        },
      });
    } catch (error) {
      logger.error(`Failed to load initial data for: ${itemId}`, error);
      this.postMessage({
        type: 'error',
        message: 'Failed to load job details. Click Refresh to try again.',
      });
    }
  }

  /**
   * Refresh the panel by re-fetching item and progress from the API.
   */
  private async refresh(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();

    try {
      const [freshItem, progress] = await Promise.all([
        queueApi.getQueueItem(this.queueItem.id),
        queueApi.getJobProgress(this.queueItem.id).catch(() => null),
      ]);

      this.queueItem = freshItem;

      if (progress) {
        this.progressState.applySnapshot(progress);
      }

      this.postMessage({
        type: 'update',
        data: {
          item: freshItem,
          progress: this.progressState.getProgress(),
          expandedPhases: [...this.progressState.getExpandedPhases()],
        },
      });
    } catch (error) {
      logger.error(`Failed to refresh queue item: ${this.queueItem.id}`, error);
    }
  }

  // ==========================================================================
  // SSE Subscription
  // ==========================================================================

  /**
   * Subscribe to SSE workflows channel for real-time progress updates.
   * Also monitors SSE connection state for polling fallback.
   */
  private subscribeSSE(): void {
    const sseManager = getSSEManager();

    // Subscribe to workflows channel for phase/step events
    const workflowsSub = sseManager.subscribe('workflows', (event: SSEEvent) => {
      this.handleWorkflowEvent(event);
    });
    this.disposables.push(workflowsSub);

    // Also keep the queue channel subscription for item-level updates (status changes)
    const queueSub = sseManager.subscribe('queue', (event: SSEEvent) => {
      this.handleQueueEvent(event);
    });
    this.disposables.push(queueSub);

    // Monitor connection state for polling fallback
    const connectionSub = sseManager.onDidChangeConnectionState(
      (state: SSEConnectionState) => this.handleConnectionStateChange(state)
    );
    this.disposables.push(connectionSub);
  }

  /**
   * Handle workflow SSE events with tiered debounce.
   * Phase events are sent immediately (high signal).
   * Step events are debounced at 200ms (high frequency).
   */
  private handleWorkflowEvent(event: SSEEvent): void {
    const data = event.data as { jobId?: string; workflowId?: string };

    // Filter: only process events for this job
    if (data.jobId !== this.queueItem.id && data.workflowId !== this.queueItem.workflowId) {
      return;
    }

    switch (event.event) {
      case 'workflow:progress': {
        // Full snapshot — apply and send immediately
        const progress = event.data as JobProgress;
        this.progressState.applySnapshot(progress);
        this.sendProgressUpdate();
        break;
      }

      case 'workflow:phase:start':
      case 'workflow:phase:complete': {
        // Phase events — send immediately (high signal)
        const phaseEvent = event.data as WorkflowPhaseEventData;
        this.progressState.applyPhaseEvent(phaseEvent);
        this.sendProgressUpdate();
        break;
      }

      case 'workflow:step:start':
      case 'workflow:step:complete': {
        // Step events — debounce 200ms
        const stepEvent = event.data as WorkflowStepEventData;
        this.progressState.applyStepEvent(stepEvent);
        this.debouncedSendProgressUpdate();
        break;
      }
    }
  }

  /**
   * Handle queue SSE events for item-level status changes.
   * When a job transitions to a terminal status (completed/failed/cancelled),
   * cleans up SSE subscriptions and timers since no further live updates are needed.
   */
  private handleQueueEvent(event: SSEEvent): void {
    const itemData = event.data as Partial<QueueItem> & { id?: string; itemId?: string };
    const itemId = itemData.id ?? itemData.itemId;

    if (itemId !== this.queueItem.id) {
      return;
    }

    // Merge partial update into current item
    this.queueItem = { ...this.queueItem, ...itemData } as QueueItem;

    // If the job just became terminal, switch to static rendering mode:
    // stop SSE subscriptions, clear timers, and do a final progress fetch
    if (TERMINAL_STATUSES.includes(this.queueItem.status)) {
      this.clearTimers();
      void this.loadFinalProgress();
      return;
    }

    this.postMessage({
      type: 'update',
      data: {
        item: this.queueItem,
        progress: this.progressState.getProgress(),
        expandedPhases: [...this.progressState.getExpandedPhases()],
      },
    });
  }

  /**
   * Fetch the final progress snapshot for a job that just reached terminal status.
   * Sends a static update to the webview with all final data.
   */
  private async loadFinalProgress(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();

    try {
      const progress = await queueApi.getJobProgress(this.queueItem.id).catch(() => null);

      if (this.isDisposed) {
        return;
      }

      if (progress) {
        this.progressState.applySnapshot(progress);
      }
    } catch (error) {
      logger.debug(`Failed to fetch final progress for: ${this.queueItem.id}`);
    }

    this.postMessage({
      type: 'update',
      data: {
        item: this.queueItem,
        progress: this.progressState.getProgress(),
        expandedPhases: [...this.progressState.getExpandedPhases()],
      },
    });
  }

  /**
   * Send the current progress state to the webview immediately.
   */
  private sendProgressUpdate(): void {
    const progress = this.progressState.getProgress();
    if (!progress) {
      return;
    }

    this.postMessage({
      type: 'progressUpdate',
      progress,
      expandedPhases: [...this.progressState.getExpandedPhases()],
    });
  }

  /**
   * Debounced version of sendProgressUpdate for step events.
   */
  private debouncedSendProgressUpdate(): void {
    if (this.stepDebounceTimer) {
      clearTimeout(this.stepDebounceTimer);
    }

    this.stepDebounceTimer = setTimeout(() => {
      this.stepDebounceTimer = undefined;
      this.sendProgressUpdate();
    }, STEP_DEBOUNCE_MS);
  }

  // ==========================================================================
  // SSE Connection Monitoring & Polling Fallback
  // ==========================================================================

  /**
   * Handle SSE connection state changes.
   * Starts polling fallback on disconnect, stops on reconnect.
   */
  private handleConnectionStateChange(state: SSEConnectionState): void {
    if (this.isDisposed) {
      return;
    }

    // Only relevant for non-terminal jobs
    if (TERMINAL_STATUSES.includes(this.queueItem.status)) {
      return;
    }

    if (state === 'connected') {
      this.isSSEConnected = true;
      this.stopPollingFallback();
      this.postMessage({
        type: 'connectionStatus',
        connected: true,
      });
    } else if (state === 'disconnected' || state === 'error') {
      this.isSSEConnected = false;
      this.startPollingFallback();
      this.postMessage({
        type: 'connectionStatus',
        connected: false,
        reconnecting: true,
      });
    }
  }

  /**
   * Start polling for progress when SSE is disconnected.
   */
  private startPollingFallback(): void {
    if (this.pollingFallbackTimer) {
      return; // Already polling
    }

    const logger = getLogger();
    logger.debug(`Starting polling fallback for job: ${this.queueItem.id}`);

    this.pollingFallbackTimer = setInterval(() => {
      void this.pollProgress();
    }, POLLING_FALLBACK_INTERVAL_MS);
  }

  /**
   * Stop the polling fallback.
   */
  private stopPollingFallback(): void {
    if (this.pollingFallbackTimer) {
      clearInterval(this.pollingFallbackTimer);
      this.pollingFallbackTimer = undefined;
    }
  }

  /**
   * Poll progress data from the REST API.
   */
  private async pollProgress(): Promise<void> {
    if (this.isDisposed || this.isSSEConnected) {
      this.stopPollingFallback();
      return;
    }

    const logger = getLogger();

    try {
      const progress = await queueApi.getJobProgress(this.queueItem.id);
      this.progressState.applySnapshot(progress);
      this.sendProgressUpdate();
    } catch (error) {
      logger.debug(`Polling fallback failed for job: ${this.queueItem.id}`);
    }
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  /**
   * Post a typed message to the webview.
   */
  private postMessage(message: JobDetailExtensionMessage): void {
    if (this.isDisposed) {
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  /**
   * Handle messages from the webview.
   */
  private handleMessage(message: JobDetailWebviewMessage): void {
    switch (message.type) {
      case 'ready':
        // Webview loaded — send current state
        this.postMessage({
          type: 'update',
          data: {
            item: this.queueItem,
            progress: this.progressState.getProgress(),
            expandedPhases: [...this.progressState.getExpandedPhases()],
          },
        });
        break;

      case 'refresh':
        void this.refresh();
        break;

      case 'pin':
        this.pin();
        break;

      case 'togglePhase':
        // Phase toggle is managed by the webview locally; we just log
        break;

      case 'openPR':
        if (message.url) {
          void vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;

      case 'openAgent':
        if (message.agentId) {
          void vscode.commands.executeCommand('generacy.agents.reveal', message.agentId);
        }
        break;

      case 'viewLogs':
        void JobLogChannel.openJobLogs(this.queueItem.id, this.queueItem.workflowName);
        break;
    }
  }

  // ==========================================================================
  // Disposal
  // ==========================================================================

  /**
   * Clear all timers (debounce + polling).
   */
  private clearTimers(): void {
    if (this.stepDebounceTimer) {
      clearTimeout(this.stepDebounceTimer);
      this.stepDebounceTimer = undefined;
    }
    this.stopPollingFallback();
  }

  /**
   * Dispose SSE subscriptions without disposing the panel.
   * Used when switching to a different item.
   */
  private disposeSubscriptions(): void {
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  /**
   * Dispose the panel and clean up all resources.
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;

    // Clear singleton reference if this is the preview instance
    if (JobDetailPanel.previewInstance === this) {
      JobDetailPanel.previewInstance = undefined;
    }

    this.clearTimers();

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
}

// ============================================================================
// Command Registration
// ============================================================================

/**
 * Register the pin detail command.
 * This should be called from the queue action registration.
 */
export function registerDetailPanelCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(CLOUD_COMMANDS.pinDetail, () => {
      const instance = JobDetailPanel.getPreviewInstance();
      if (instance && !instance.pinned) {
        instance.pin();
      }
    })
  );
}
