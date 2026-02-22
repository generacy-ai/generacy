/**
 * WorkItemDetailPanel - Webview panel for displaying queue item details.
 *
 * Implements a singleton preview pattern with pinning support:
 * - A single unpinned preview panel is reused when selecting different items
 * - Pinning a panel preserves it and allows a new preview to open alongside
 * - SSE subscription keeps the displayed item's data up-to-date in real time
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { queueApi } from '../../../api/endpoints/queue';
import { getSSEManager } from '../../../api/sse';
import type { QueueItem, QueueStatus, QueuePriority, SSEEvent } from '../../../api/types';
import { CLOUD_COMMANDS } from '../../../constants';

// ============================================================================
// Types
// ============================================================================

/** Messages sent from the detail webview to the extension */
type DetailWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'pin' }
  | { type: 'openAgent'; agentId: string };

// ============================================================================
// WorkItemDetailPanel
// ============================================================================

/**
 * Webview panel for displaying detailed information about a queue work item.
 *
 * Supports a preview/pin workflow:
 * - `showPreview()` reuses an existing unpinned panel or creates a new one
 * - `pin()` freezes the current panel in place so subsequent selections open a fresh preview
 */
export class WorkItemDetailPanel {
  /** The singleton unpinned preview instance */
  private static previewInstance: WorkItemDetailPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private queueItem: QueueItem;
  private isPinned = false;
  private isDisposed = false;

  private constructor(
    panel: vscode.WebviewPanel,
    item: QueueItem
  ) {
    this.panel = panel;
    this.queueItem = item;

    // Set initial content
    this.panel.webview.html = this.generateHtml(item);

    // Listen for messages from webview
    this.panel.webview.onDidReceiveMessage(
      (message: DetailWebviewMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(
      () => this.dispose(),
      null,
      this.disposables
    );

    // Subscribe to SSE for real-time updates
    this.subscribeSSE();
  }

  // ==========================================================================
  // Static Factory
  // ==========================================================================

  /**
   * Show a preview panel for a queue item.
   *
   * - If an unpinned preview exists, it is reused with updated content.
   * - If no unpinned preview exists (or the current one is pinned), a new panel is created.
   */
  public static showPreview(item: QueueItem, extensionUri: vscode.Uri): WorkItemDetailPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    // Reuse existing unpinned preview
    if (WorkItemDetailPanel.previewInstance && !WorkItemDetailPanel.previewInstance.isDisposed) {
      const instance = WorkItemDetailPanel.previewInstance;
      instance.updateContent(item);
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

    const instance = new WorkItemDetailPanel(panel, item);
    WorkItemDetailPanel.previewInstance = instance;
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
    if (WorkItemDetailPanel.previewInstance === this) {
      WorkItemDetailPanel.previewInstance = undefined;
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
  public static getPreviewInstance(): WorkItemDetailPanel | undefined {
    return WorkItemDetailPanel.previewInstance;
  }

  // ==========================================================================
  // Content
  // ==========================================================================

  /**
   * Update the panel with a new queue item's data.
   */
  private updateContent(item: QueueItem): void {
    this.queueItem = item;
    this.panel.title = this.isPinned
      ? `$(pin) Queue: ${item.workflowName}`
      : `Queue: ${item.workflowName}`;
    this.panel.webview.html = this.generateHtml(item);
  }

  /**
   * Refresh the panel by re-fetching the item from the API.
   */
  private async refresh(): Promise<void> {
    if (this.isDisposed) {
      return;
    }

    const logger = getLogger();

    try {
      const freshItem = await queueApi.getQueueItem(this.queueItem.id);
      this.updateContent(freshItem);
    } catch (error) {
      logger.error(`Failed to refresh queue item: ${this.queueItem.id}`, error);
    }
  }

  // ==========================================================================
  // SSE Subscription
  // ==========================================================================

  /**
   * Subscribe to SSE queue events to keep the panel up-to-date.
   */
  private subscribeSSE(): void {
    const sseManager = getSSEManager();

    const subscription = sseManager.subscribe('queue', (event: SSEEvent) => {
      const itemData = event.data as Partial<QueueItem> & { id?: string; itemId?: string };
      const itemId = itemData.id ?? itemData.itemId;

      // Only react to events for the item we're displaying
      if (itemId !== this.queueItem.id) {
        return;
      }

      // Merge partial update into current item and refresh the HTML
      const updatedItem = { ...this.queueItem, ...itemData } as QueueItem;
      this.updateContent(updatedItem);
    });

    this.disposables.push(subscription);
  }

  // ==========================================================================
  // Message Handling
  // ==========================================================================

  private handleMessage(message: DetailWebviewMessage): void {
    switch (message.type) {
      case 'ready':
        // Webview loaded — could send initial data if using postMessage pattern
        break;

      case 'refresh':
        void this.refresh();
        break;

      case 'pin':
        this.pin();
        break;

      case 'openAgent':
        if (message.agentId) {
          void vscode.commands.executeCommand('generacy.agents.reveal', message.agentId);
        }
        break;
    }
  }

  // ==========================================================================
  // HTML Generation
  // ==========================================================================

  private generateHtml(item: QueueItem): string {
    const nonce = this.getNonce();

    const statusColors: Record<QueueStatus, string> = {
      pending: '#f0ad4e',
      running: '#5bc0de',
      completed: '#5cb85c',
      failed: '#d9534f',
      cancelled: '#777',
    };

    const priorityColors: Record<QueuePriority, string> = {
      low: '#777',
      normal: '#5bc0de',
      high: '#f0ad4e',
      urgent: '#d9534f',
    };

    const formatDateTime = (dateStr: string | undefined): string => {
      if (!dateStr) return 'N/A';
      return new Date(dateStr).toLocaleString();
    };

    const calculateDuration = (
      startStr: string | undefined,
      endStr: string | undefined
    ): string => {
      if (!startStr) return 'N/A';
      const start = new Date(startStr);
      const end = endStr ? new Date(endStr) : new Date();
      const diffMs = end.getTime() - start.getTime();
      const diffSec = Math.floor(diffMs / 1000);

      if (diffSec < 60) {
        return `${diffSec} second${diffSec !== 1 ? 's' : ''}`;
      }
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        return `${diffMin} minute${diffMin !== 1 ? 's' : ''} ${diffSec % 60}s`;
      }
      const diffHour = Math.floor(diffMin / 60);
      return `${diffHour} hour${diffHour !== 1 ? 's' : ''} ${diffMin % 60}m`;
    };

    const statusColor = statusColors[item.status];
    const priorityColor = priorityColors[item.priority];
    const pinButtonLabel = this.isPinned ? 'Pinned' : 'Pin';
    const pinButtonDisabled = this.isPinned ? 'disabled' : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>Queue Item Details</title>
  <style nonce="${nonce}">
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
      margin: 0;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    h1 {
      margin: 0;
      font-size: 1.4em;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
    .actions button {
      background-color: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
      border-radius: 4px;
    }
    .actions button:hover:not(:disabled) {
      background-color: var(--vscode-button-secondaryHoverBackground);
    }
    .actions button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .section {
      margin-bottom: 24px;
    }
    .section-title {
      font-weight: 600;
      font-size: 1.1em;
      margin-bottom: 12px;
      color: var(--vscode-textLink-foreground);
    }
    .field {
      display: flex;
      margin-bottom: 8px;
    }
    .field-label {
      font-weight: 500;
      min-width: 140px;
      color: var(--vscode-descriptionForeground);
    }
    .field-value {
      flex: 1;
    }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-weight: 500;
      text-transform: uppercase;
      font-size: 0.85em;
    }
    .error-section {
      background-color: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      border-radius: 4px;
      padding: 12px;
      margin-top: 16px;
    }
    .error-title {
      color: var(--vscode-inputValidation-errorForeground);
      font-weight: 600;
      margin-bottom: 8px;
    }
    .error-message {
      font-family: var(--vscode-editor-font-family);
      white-space: pre-wrap;
      word-break: break-word;
    }
    code {
      font-family: var(--vscode-editor-font-family);
      background-color: var(--vscode-textCodeBlock-background);
      padding: 2px 6px;
      border-radius: 3px;
    }
    .timeline {
      position: relative;
      padding-left: 20px;
    }
    .timeline::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 4px;
      bottom: 4px;
      width: 2px;
      background-color: var(--vscode-panel-border);
    }
    .timeline-entry {
      position: relative;
      margin-bottom: 12px;
    }
    .timeline-entry::before {
      content: '';
      position: absolute;
      left: -18px;
      top: 6px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background-color: var(--vscode-textLink-foreground);
    }
    .timeline-entry.inactive::before {
      background-color: var(--vscode-panel-border);
    }
    .timeline-label {
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }
    .timeline-value {
      margin-left: 8px;
    }
    .agent-link {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-decoration: underline;
    }
    .agent-link:hover {
      color: var(--vscode-textLink-activeForeground);
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(item.workflowName)}</h1>
    <div class="actions">
      <button onclick="pinPanel()" ${pinButtonDisabled}>${pinButtonLabel}</button>
      <button onclick="refreshPanel()">Refresh</button>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Status</div>
    <div class="field">
      <span class="field-label">Current Status</span>
      <span class="field-value">
        <span class="badge" style="background-color: ${statusColor}; color: white;">
          ${item.status.toUpperCase()}
        </span>
      </span>
    </div>
    <div class="field">
      <span class="field-label">Priority</span>
      <span class="field-value">
        <span class="badge" style="background-color: ${priorityColor}; color: white;">
          ${item.priority.toUpperCase()}
        </span>
      </span>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Workflow Details</div>
    <div class="field">
      <span class="field-label">Workflow ID</span>
      <span class="field-value"><code>${escapeHtml(item.workflowId)}</code></span>
    </div>
    <div class="field">
      <span class="field-label">Queue Item ID</span>
      <span class="field-value"><code>${escapeHtml(item.id)}</code></span>
    </div>
    ${item.repository ? `<div class="field">
      <span class="field-label">Repository</span>
      <span class="field-value"><code>${escapeHtml(item.repository)}</code></span>
    </div>` : ''}
    ${item.assigneeId ? `<div class="field">
      <span class="field-label">Assigned Agent</span>
      <span class="field-value">
        <span class="agent-link" onclick="openAgent('${escapeHtml(item.assigneeId)}')">${escapeHtml(item.assigneeId)}</span>
      </span>
    </div>` : ''}
  </div>

  <div class="section">
    <div class="section-title">Timeline</div>
    <div class="timeline">
      <div class="timeline-entry">
        <span class="timeline-label">Queued</span>
        <span class="timeline-value">${formatDateTime(item.queuedAt)}</span>
      </div>
      <div class="timeline-entry ${item.startedAt ? '' : 'inactive'}">
        <span class="timeline-label">Started</span>
        <span class="timeline-value">${formatDateTime(item.startedAt)}</span>
      </div>
      <div class="timeline-entry ${item.completedAt ? '' : 'inactive'}">
        <span class="timeline-label">${item.status === 'failed' ? 'Failed' : item.status === 'cancelled' ? 'Cancelled' : 'Completed'}</span>
        <span class="timeline-value">${formatDateTime(item.completedAt)}</span>
      </div>
    </div>
    <div class="field" style="margin-top: 8px;">
      <span class="field-label">Duration</span>
      <span class="field-value">${calculateDuration(item.startedAt, item.completedAt)}</span>
    </div>
  </div>

  ${item.error ? `<div class="error-section">
    <div class="error-title">Error Details</div>
    <div class="error-message">${escapeHtml(item.error)}</div>
  </div>` : ''}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function pinPanel() {
      vscode.postMessage({ type: 'pin' });
    }

    function refreshPanel() {
      vscode.postMessage({ type: 'refresh' });
    }

    function openAgent(agentId) {
      vscode.postMessage({ type: 'openAgent', agentId: agentId });
    }

    // Notify extension that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Generate a CSP nonce.
   */
  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  // ==========================================================================
  // Disposal
  // ==========================================================================

  /**
   * Dispose the panel and clean up resources.
   */
  public dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;

    // Clear singleton reference if this is the preview instance
    if (WorkItemDetailPanel.previewInstance === this) {
      WorkItemDetailPanel.previewInstance = undefined;
    }

    this.panel.dispose();

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Escape HTML special characters.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
      const instance = WorkItemDetailPanel.getPreviewInstance();
      if (instance && !instance.pinned) {
        instance.pin();
      }
    })
  );
}
