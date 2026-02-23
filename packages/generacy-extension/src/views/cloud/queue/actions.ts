/**
 * Queue Actions - Command handlers for workflow queue operations.
 * Provides cancel, retry, priority adjustment, and view details actions.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { queueApi } from '../../../api/endpoints/queue';
import { agentsApi } from '../../../api/endpoints/agents';
import { QueueItem, QueuePriority, QueueStatus } from '../../../api/types';
import { QueueTreeItem, isQueueTreeItem } from './tree-item';
import { QueueTreeProvider } from './provider';
import { CLOUD_COMMANDS } from '../../../constants';
import { JobDetailPanel, registerDetailPanelCommands } from './detail-panel';

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
 * Assign a work item to an available agent via quick pick
 */
export async function assignWorkItem(
  item: QueueTreeItem | QueueItem,
  provider: QueueTreeProvider
): Promise<boolean> {
  const logger = getLogger();
  const queueItem = 'queueItem' in item ? item.queueItem : item;

  // Only pending items can be assigned
  if (queueItem.status !== 'pending') {
    vscode.window.showWarningMessage(
      `Cannot assign workflow "${queueItem.workflowName}" - status is ${queueItem.status}`
    );
    return false;
  }

  try {
    // Fetch available (idle) agents
    const agentResponse = await agentsApi.getAgents({ status: 'idle' });

    if (agentResponse.items.length === 0) {
      vscode.window.showWarningMessage('No available agents to assign. All agents are busy or offline.');
      return false;
    }

    // Show quick pick with agent details
    const selected = await vscode.window.showQuickPick(
      agentResponse.items.map((agent) => ({
        label: agent.name,
        description: agent.type,
        detail: agent.id,
      })),
      { placeHolder: 'Select an agent to assign this work item to' }
    );

    if (!selected) {
      logger.debug('Assign action cancelled by user');
      return false;
    }

    logger.info(`Assigning queue item ${queueItem.id} to agent ${selected.detail}`);
    await agentsApi.assignWorkItem(queueItem.id, selected.detail!);

    vscode.window.showInformationMessage(
      `"${queueItem.workflowName}" assigned to ${selected.label}`
    );

    provider.refresh();
    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to assign queue item: ${queueItem.id}`, error);
    vscode.window.showErrorMessage(`Failed to assign work item: ${errorMessage}`);
    return false;
  }
}

/**
 * Set queue item priority via quick pick with all priority levels
 */
export async function setPriority(
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

  const priorities: QueuePriority[] = ['low', 'normal', 'high', 'urgent'];

  const selected = await vscode.window.showQuickPick(
    priorities.map((p) => ({
      label: p.charAt(0).toUpperCase() + p.slice(1),
      description: p === queueItem.priority ? '(current)' : undefined,
      value: p,
    })),
    { placeHolder: 'Set priority level' }
  );

  if (!selected) {
    logger.debug('Set priority action cancelled by user');
    return false;
  }

  if (selected.value === queueItem.priority) {
    return false;
  }

  return updatePriority(queueItem, selected.value, provider);
}

/**
 * Show detailed information about a queue item in a webview panel.
 * Delegates to JobDetailPanel which supports singleton preview and pinning.
 */
export async function viewQueueItemDetails(
  item: QueueTreeItem | QueueItem,
  extensionUri: vscode.Uri
): Promise<void> {
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

  JobDetailPanel.showPreview(freshItem, extensionUri);
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
        await viewQueueItemDetails(item, context.extensionUri);
      }
    )
  );

  // Register detail panel commands (pin, etc.)
  registerDetailPanelCommands(context);

  // Assign to agent action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CLOUD_COMMANDS.assignWorkItem,
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item to assign');
          return;
        }
        await assignWorkItem(item, provider);
      }
    )
  );

  // Set priority action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CLOUD_COMMANDS.setPriority,
      async (item?: QueueTreeItem) => {
        if (!item || !isQueueTreeItem(item)) {
          vscode.window.showWarningMessage('Please select a queue item');
          return;
        }
        await setPriority(item, provider);
      }
    )
  );

  logger.info('Queue action commands registered');
}
