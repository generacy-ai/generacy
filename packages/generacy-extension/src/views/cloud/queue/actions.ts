/**
 * Queue Actions - Command handlers for workflow queue operations.
 * Provides cancel, retry, priority adjustment, and view details actions.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { queueApi } from '../../../api/endpoints/queue';
import { QueueItem, QueuePriority, QueueStatus } from '../../../api/types';
import { QueueTreeItem, isQueueTreeItem } from './tree-item';
import { QueueTreeProvider } from './provider';

/**
 * Priority levels in ascending order for adjustment
 */
const PRIORITY_ORDER: QueuePriority[] = ['low', 'normal', 'high', 'urgent'];

/**
 * Get the index of a priority in the order
 */
function getPriorityIndex(priority: QueuePriority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

/**
 * Cancel a queue item with confirmation dialog
 */
export async function cancelQueueItem(
  item: QueueTreeItem | QueueItem,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  // Verify item can be cancelled (only pending or running)
  const cancellableStatuses: QueueStatus[] = ['pending', 'running'];
  if (!cancellableStatuses.includes(queueItem.status)) {
    vscode.window.showWarningMessage(
      `Cannot cancel workflow "${queueItem.workflowName}" - status is ${queueItem.status}`
    );
    return false;
  }

  // Show confirmation dialog
  const action = await vscode.window.showWarningMessage(
    `Are you sure you want to cancel "${queueItem.workflowName}"?`,
    { modal: true },
    'Cancel Workflow'
  );

  if (action !== 'Cancel Workflow') {
    logger.debug('Cancel action aborted by user');
    return false;
  }

  try {
    logger.info(`Cancelling queue item: ${queueItem.id}`);
    await queueApi.cancelQueueItem(queueItem.id);

    vscode.window.showInformationMessage(`Workflow "${queueItem.workflowName}" cancelled`);

    // Refresh the tree to show updated status
    provider.refresh();
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to cancel queue item: ${queueItem.id}`, error);
    vscode.window.showErrorMessage(`Failed to cancel workflow: ${errorMessage}`);
    return false;
  }
}

/**
 * Retry a failed queue item
 */
export async function retryQueueItem(
  item: QueueTreeItem | QueueItem,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  // Verify item can be retried (only failed or cancelled)
  const retryableStatuses: QueueStatus[] = ['failed', 'cancelled'];
  if (!retryableStatuses.includes(queueItem.status)) {
    vscode.window.showWarningMessage(
      `Cannot retry workflow "${queueItem.workflowName}" - status is ${queueItem.status}`
    );
    return false;
  }

  try {
    logger.info(`Retrying queue item: ${queueItem.id}`);
    const newItem = await queueApi.retryQueueItem(queueItem.id);

    vscode.window.showInformationMessage(
      `Workflow "${queueItem.workflowName}" queued for retry (ID: ${newItem.id})`
    );

    // Refresh the tree to show the new item
    provider.refresh();
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to retry queue item: ${queueItem.id}`, error);
    vscode.window.showErrorMessage(`Failed to retry workflow: ${errorMessage}`);
    return false;
  }
}

/**
 * Increase queue item priority (move up in the priority order)
 */
export async function increasePriority(
  item: QueueTreeItem | QueueItem,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  // Only pending items can have priority changed
  if (queueItem.status !== 'pending') {
    vscode.window.showWarningMessage(
      `Cannot change priority - workflow "${queueItem.workflowName}" is ${queueItem.status}`
    );
    return false;
  }

  const currentIndex = getPriorityIndex(queueItem.priority);

  // Check if already at highest priority
  if (currentIndex >= PRIORITY_ORDER.length - 1) {
    vscode.window.showInformationMessage(
      `"${queueItem.workflowName}" is already at highest priority (urgent)`
    );
    return false;
  }

  const newPriority = PRIORITY_ORDER[currentIndex + 1];
  if (!newPriority) {
    return false;
  }

  return updatePriority(queueItem, newPriority, provider);
}

/**
 * Decrease queue item priority (move down in the priority order)
 */
export async function decreasePriority(
  item: QueueTreeItem | QueueItem,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  // Only pending items can have priority changed
  if (queueItem.status !== 'pending') {
    vscode.window.showWarningMessage(
      `Cannot change priority - workflow "${queueItem.workflowName}" is ${queueItem.status}`
    );
    return false;
  }

  const currentIndex = getPriorityIndex(queueItem.priority);

  // Check if already at lowest priority
  if (currentIndex <= 0) {
    vscode.window.showInformationMessage(
      `"${queueItem.workflowName}" is already at lowest priority (low)`
    );
    return false;
  }

  const newPriority = PRIORITY_ORDER[currentIndex - 1];
  if (!newPriority) {
    return false;
  }

  return updatePriority(queueItem, newPriority, provider);
}

/**
 * Update the priority of a queue item
 */
async function updatePriority(
  queueItem: QueueItem,
  newPriority: QueuePriority,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();

  try {
    logger.info(`Updating priority for ${queueItem.id}: ${queueItem.priority} -> ${newPriority}`);
    await queueApi.updatePriority(queueItem.id, newPriority);

    vscode.window.showInformationMessage(
      `Priority updated: "${queueItem.workflowName}" is now ${newPriority}`
    );

    // Refresh the tree to show updated priority
    provider.refresh();
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to update priority for ${queueItem.id}`, error);
    vscode.window.showErrorMessage(`Failed to update priority: ${errorMessage}`);
    return false;
  }
}

/**
 * Show detailed information about a queue item in a webview panel
 */
export async function viewQueueItemDetails(item: QueueTreeItem | QueueItem): Promise<void> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  logger.info(`Viewing details for queue item: ${queueItem.id}`);

  // Fetch fresh data from API
  let freshItem: QueueItem;
  try {
    freshItem = await queueApi.getQueueItem(queueItem.id);
  } catch (error) {
    logger.error(`Failed to fetch queue item details: ${queueItem.id}`, error);
    // Use cached data if fetch fails
    freshItem = queueItem;
  }

  // Create and show a webview panel with the details
  const panel = vscode.window.createWebviewPanel(
    'generacy.queueItemDetails',
    `Queue: ${freshItem.workflowName}`,
    vscode.ViewColumn.One,
    {
      enableScripts: false,
      localResourceRoots: [],
    }
  );

  panel.webview.html = generateDetailsHtml(freshItem);
}

/**
 * Generate HTML content for the queue item details panel
 */
function generateDetailsHtml(item: QueueItem): string {
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Queue Item Details</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      padding: 20px;
      line-height: 1.6;
    }
    h1 {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding-bottom: 10px;
      margin-bottom: 20px;
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
  </style>
</head>
<body>
  <h1>${escapeHtml(item.workflowName)}</h1>

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
    ${
      item.repository
        ? `<div class="field">
      <span class="field-label">Repository</span>
      <span class="field-value"><code>${escapeHtml(item.repository)}</code></span>
    </div>`
        : ''
    }
    ${
      item.assigneeId
        ? `<div class="field">
      <span class="field-label">Assignee</span>
      <span class="field-value">${escapeHtml(item.assigneeId)}</span>
    </div>`
        : ''
    }
  </div>

  <div class="section">
    <div class="section-title">Timeline</div>
    <div class="field">
      <span class="field-label">Queued At</span>
      <span class="field-value">${formatDateTime(item.queuedAt)}</span>
    </div>
    <div class="field">
      <span class="field-label">Started At</span>
      <span class="field-value">${formatDateTime(item.startedAt)}</span>
    </div>
    <div class="field">
      <span class="field-label">Completed At</span>
      <span class="field-value">${formatDateTime(item.completedAt)}</span>
    </div>
    <div class="field">
      <span class="field-label">Duration</span>
      <span class="field-value">${calculateDuration(item.startedAt, item.completedAt)}</span>
    </div>
  </div>

  ${
    item.error
      ? `<div class="error-section">
    <div class="error-title">Error Details</div>
    <div class="error-message">${escapeHtml(item.error)}</div>
  </div>`
      : ''
  }
</body>
</html>`;
}

/**
 * Escape HTML special characters
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Register all queue action commands
 */
export function registerQueueActions(
  context: vscode.ExtensionContext,
  provider: QueueTreeProvider
): void {
  const logger = getLogger();
  logger.debug('Registering queue action commands');

  // Cancel action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.queue.cancel',
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item to cancel');
          return;
        }
        await cancelQueueItem(item, provider);
      }
    )
  );

  // Retry action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.queue.retry',
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item to retry');
          return;
        }
        await retryQueueItem(item, provider);
      }
    )
  );

  // Increase priority action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.queue.priorityUp',
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item');
          return;
        }
        await increasePriority(item, provider);
      }
    )
  );

  // Decrease priority action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.queue.priorityDown',
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item');
          return;
        }
        await decreasePriority(item, provider);
      }
    )
  );

  // View details action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'generacy.queue.viewDetails',
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item to view');
          return;
        }
        await viewQueueItemDetails(item);
      }
    )
  );

  logger.info('Queue action commands registered');
}
