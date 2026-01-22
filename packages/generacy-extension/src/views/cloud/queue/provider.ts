/**
 * QueueTreeProvider - Tree data provider for the Workflow Queue view.
 * Provides queue items with API polling, filtering, and real-time status updates.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import { queueApi, QueueFilterOptions } from '../../../api/endpoints/queue';
import { QueueItem, QueueStatus } from '../../../api/types';
import { VIEWS } from '../../../constants';
import {
  QueueTreeItem,
  QueueFilterGroupItem,
  QueueEmptyItem,
  QueueLoadingItem,
  QueueErrorItem,
  QueueExplorerItem,
  isQueueFilterGroupItem,
} from './tree-item';

/**
 * View mode for queue display
 */
export type QueueViewMode = 'flat' | 'byStatus' | 'byRepository' | 'byAssignee';

/**
 * Queue tree provider options
 */
export interface QueueTreeProviderOptions {
  /** Polling interval in milliseconds (default: 30000 = 30s) */
  pollingInterval?: number;
  /** Initial view mode */
  viewMode?: QueueViewMode;
  /** Page size for API requests */
  pageSize?: number;
}

/**
 * QueueTreeProvider implements TreeDataProvider for workflow queue items.
 *
 * Features:
 * - API polling for real-time updates
 * - Filtering by status, repository, and assignee
 * - Multiple view modes (flat, grouped by status/repo/assignee)
 * - Loading and error states
 */
export class QueueTreeProvider
  implements vscode.TreeDataProvider<QueueExplorerItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    QueueExplorerItem | undefined | null | void
  >();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private queueItems: QueueItem[] = [];
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private isLoading = false;
  private loadError: Error | undefined;
  private viewMode: QueueViewMode;
  private activeFilters: QueueFilterOptions = {};
  private readonly pollingInterval: number;
  private readonly pageSize: number;
  private isPaused = false;

  constructor(options: QueueTreeProviderOptions = {}) {
    const logger = getLogger();
    logger.debug('QueueTreeProvider initialized');

    this.pollingInterval = options.pollingInterval ?? 30000; // Default 30s
    this.viewMode = options.viewMode ?? 'flat';
    this.pageSize = options.pageSize ?? 50;

    // Listen for authentication changes
    const authService = getAuthService();
    this.disposables.push(
      authService.onDidChange((event) => {
        if (event.newState.isAuthenticated) {
          logger.info('User authenticated, starting queue polling');
          this.startPolling();
        } else {
          logger.info('User logged out, stopping queue polling');
          this.stopPolling();
          this.queueItems = [];
          this._onDidChangeTreeData.fire();
        }
      })
    );

    // Start polling if already authenticated
    if (authService.isAuthenticated()) {
      this.startPolling();
    }
  }

  // ==========================================================================
  // TreeDataProvider Implementation
  // ==========================================================================

  /**
   * Get tree item for display
   */
  public getTreeItem(element: QueueExplorerItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a tree item
   */
  public async getChildren(element?: QueueExplorerItem): Promise<QueueExplorerItem[]> {
    const authService = getAuthService();

    // Check authentication
    if (!authService.isAuthenticated()) {
      return [new QueueEmptyItem('Sign in to view the workflow queue')];
    }

    // Root level
    if (!element) {
      // Show loading state
      if (this.isLoading && this.queueItems.length === 0) {
        return [new QueueLoadingItem()];
      }

      // Show error state
      if (this.loadError && this.queueItems.length === 0) {
        return [new QueueErrorItem(this.loadError)];
      }

      // Return items based on view mode
      return this.getRootChildren();
    }

    // Filter group level - return items matching the filter
    if (isQueueFilterGroupItem(element)) {
      return this.getFilteredItems(element.filterType, element.filterValue);
    }

    return [];
  }

  /**
   * Get parent of a tree item (for reveal support)
   */
  public getParent(element: QueueExplorerItem): QueueExplorerItem | undefined {
    // Queue items at root level in flat mode have no parent
    // In grouped modes, find the parent group
    if (element instanceof QueueTreeItem && this.viewMode !== 'flat') {
      const item = element.queueItem;

      switch (this.viewMode) {
        case 'byStatus':
          return this.createStatusGroup(item.status);
        case 'byRepository':
          if (item.repository) {
            return this.createRepositoryGroup(item.repository);
          }
          break;
        case 'byAssignee':
          if (item.assigneeId) {
            return this.createAssigneeGroup(item.assigneeId);
          }
          break;
      }
    }

    return undefined;
  }

  // ==========================================================================
  // Root Children Methods
  // ==========================================================================

  /**
   * Get children for root level based on view mode
   */
  private getRootChildren(): QueueExplorerItem[] {
    if (this.queueItems.length === 0) {
      return [new QueueEmptyItem('No items in queue')];
    }

    switch (this.viewMode) {
      case 'flat':
        return this.queueItems.map((item) => new QueueTreeItem(item));

      case 'byStatus':
        return this.getStatusGroups();

      case 'byRepository':
        return this.getRepositoryGroups();

      case 'byAssignee':
        return this.getAssigneeGroups();

      default:
        return this.queueItems.map((item) => new QueueTreeItem(item));
    }
  }

  /**
   * Get status filter groups
   */
  private getStatusGroups(): QueueFilterGroupItem[] {
    const statusCounts = new Map<QueueStatus, number>();

    for (const item of this.queueItems) {
      const count = statusCounts.get(item.status) ?? 0;
      statusCounts.set(item.status, count + 1);
    }

    // Sort by priority: running > pending > failed > completed > cancelled
    const statusOrder: QueueStatus[] = ['running', 'pending', 'failed', 'completed', 'cancelled'];

    return statusOrder
      .filter((status) => statusCounts.has(status))
      .map((status) => this.createStatusGroup(status, statusCounts.get(status)));
  }

  /**
   * Create a status group item
   */
  private createStatusGroup(status: QueueStatus, count?: number): QueueFilterGroupItem {
    const actualCount = count ?? this.queueItems.filter((i) => i.status === status).length;
    const label = this.capitalizeFirst(status);
    return new QueueFilterGroupItem(label, 'status', status, actualCount);
  }

  /**
   * Get repository filter groups
   */
  private getRepositoryGroups(): QueueFilterGroupItem[] {
    const repoCounts = new Map<string, number>();

    for (const item of this.queueItems) {
      const repo = item.repository ?? 'Unknown';
      const count = repoCounts.get(repo) ?? 0;
      repoCounts.set(repo, count + 1);
    }

    return Array.from(repoCounts.entries())
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .map(([repo, count]) => this.createRepositoryGroup(repo, count));
  }

  /**
   * Create a repository group item
   */
  private createRepositoryGroup(repository: string, count?: number): QueueFilterGroupItem {
    const actualCount =
      count ?? this.queueItems.filter((i) => (i.repository ?? 'Unknown') === repository).length;
    return new QueueFilterGroupItem(repository, 'repository', repository, actualCount);
  }

  /**
   * Get assignee filter groups
   */
  private getAssigneeGroups(): QueueFilterGroupItem[] {
    const assigneeCounts = new Map<string, number>();

    for (const item of this.queueItems) {
      const assignee = item.assigneeId ?? 'Unassigned';
      const count = assigneeCounts.get(assignee) ?? 0;
      assigneeCounts.set(assignee, count + 1);
    }

    return Array.from(assigneeCounts.entries())
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .map(([assignee, count]) => this.createAssigneeGroup(assignee, count));
  }

  /**
   * Create an assignee group item
   */
  private createAssigneeGroup(assigneeId: string, count?: number): QueueFilterGroupItem {
    const actualCount =
      count ?? this.queueItems.filter((i) => (i.assigneeId ?? 'Unassigned') === assigneeId).length;
    const label = assigneeId === 'Unassigned' ? 'Unassigned' : assigneeId;
    return new QueueFilterGroupItem(label, 'assignee', assigneeId, actualCount);
  }

  /**
   * Get items matching a specific filter
   */
  private getFilteredItems(
    filterType: 'status' | 'repository' | 'assignee',
    filterValue: string
  ): QueueTreeItem[] {
    let filtered: QueueItem[];

    switch (filterType) {
      case 'status':
        filtered = this.queueItems.filter((i) => i.status === filterValue);
        break;
      case 'repository':
        filtered = this.queueItems.filter(
          (i) => (i.repository ?? 'Unknown') === filterValue
        );
        break;
      case 'assignee':
        filtered = this.queueItems.filter(
          (i) => (i.assigneeId ?? 'Unassigned') === filterValue
        );
        break;
      default:
        filtered = [];
    }

    return filtered.map((item) => new QueueTreeItem(item));
  }

  // ==========================================================================
  // Polling Methods
  // ==========================================================================

  /**
   * Start polling for queue updates
   */
  public startPolling(): void {
    if (this.pollingTimer) {
      return; // Already polling
    }

    const logger = getLogger();
    logger.debug(`Starting queue polling (interval: ${this.pollingInterval}ms)`);

    // Fetch immediately
    void this.fetchQueue();

    // Set up interval for subsequent fetches
    this.pollingTimer = setInterval(() => {
      if (!this.isPaused) {
        void this.fetchQueue();
      }
    }, this.pollingInterval);
  }

  /**
   * Stop polling for queue updates
   */
  public stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;

      const logger = getLogger();
      logger.debug('Queue polling stopped');
    }
  }

  /**
   * Pause polling (e.g., when view is not visible)
   */
  public pausePolling(): void {
    this.isPaused = true;
    const logger = getLogger();
    logger.debug('Queue polling paused');
  }

  /**
   * Resume polling
   */
  public resumePolling(): void {
    this.isPaused = false;
    const logger = getLogger();
    logger.debug('Queue polling resumed');

    // Fetch immediately on resume
    void this.fetchQueue();
  }

  /**
   * Fetch queue items from API
   */
  private async fetchQueue(): Promise<void> {
    const logger = getLogger();
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      logger.debug('Not authenticated, skipping queue fetch');
      return;
    }

    if (this.isLoading) {
      logger.debug('Already loading, skipping queue fetch');
      return;
    }

    this.isLoading = true;

    // Only fire tree update for initial load
    if (this.queueItems.length === 0) {
      this._onDidChangeTreeData.fire();
    }

    try {
      logger.debug('Fetching queue items', { filters: this.activeFilters });

      const response = await queueApi.getQueue({
        ...this.activeFilters,
        pageSize: this.pageSize,
      });

      // Check if data has changed
      const hasChanges = this.hasQueueChanged(response.items);

      this.queueItems = response.items;
      this.loadError = undefined;

      if (hasChanges) {
        logger.debug(`Queue updated: ${response.items.length} items`);
        this._onDidChangeTreeData.fire();
      }
    } catch (error) {
      logger.error('Failed to fetch queue', error);
      this.loadError = error instanceof Error ? error : new Error(String(error));

      // Only update tree if this is the first error or we had data
      if (this.queueItems.length === 0) {
        this._onDidChangeTreeData.fire();
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Check if queue data has changed
   */
  private hasQueueChanged(newItems: QueueItem[]): boolean {
    if (newItems.length !== this.queueItems.length) {
      return true;
    }

    // Check if any item has changed
    for (let i = 0; i < newItems.length; i++) {
      const newItem = newItems[i];
      const oldItem = this.queueItems.find((item) => item.id === newItem?.id);

      if (!oldItem || !newItem) {
        return true;
      }

      // Check key fields for changes
      if (
        oldItem.status !== newItem.status ||
        oldItem.priority !== newItem.priority ||
        oldItem.startedAt !== newItem.startedAt ||
        oldItem.completedAt !== newItem.completedAt
      ) {
        return true;
      }
    }

    return false;
  }

  // ==========================================================================
  // Public API Methods
  // ==========================================================================

  /**
   * Manually refresh the queue
   */
  public refresh(): void {
    const logger = getLogger();
    logger.info('Manually refreshing queue');
    void this.fetchQueue();
  }

  /**
   * Set the view mode
   */
  public setViewMode(mode: QueueViewMode): void {
    const logger = getLogger();
    logger.info(`Setting queue view mode: ${mode}`);

    this.viewMode = mode;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current view mode
   */
  public getViewMode(): QueueViewMode {
    return this.viewMode;
  }

  /**
   * Set status filter
   */
  public setStatusFilter(status: QueueStatus | QueueStatus[] | undefined): void {
    const logger = getLogger();
    logger.info(`Setting status filter: ${status}`);

    this.activeFilters.status = status;
    void this.fetchQueue();
  }

  /**
   * Set repository filter
   */
  public setRepositoryFilter(repository: string | undefined): void {
    const logger = getLogger();
    logger.info(`Setting repository filter: ${repository}`);

    this.activeFilters.repository = repository;
    void this.fetchQueue();
  }

  /**
   * Set assignee filter
   */
  public setAssigneeFilter(assigneeId: string | undefined): void {
    const logger = getLogger();
    logger.info(`Setting assignee filter: ${assigneeId}`);

    this.activeFilters.assigneeId = assigneeId;
    void this.fetchQueue();
  }

  /**
   * Clear all filters
   */
  public clearFilters(): void {
    const logger = getLogger();
    logger.info('Clearing all queue filters');

    this.activeFilters = {};
    void this.fetchQueue();
  }

  /**
   * Get current filters
   */
  public getFilters(): QueueFilterOptions {
    return { ...this.activeFilters };
  }

  /**
   * Get a queue item by ID
   */
  public getQueueItemById(id: string): QueueItem | undefined {
    return this.queueItems.find((item) => item.id === id);
  }

  /**
   * Get all queue items
   */
  public getAllItems(): QueueItem[] {
    return [...this.queueItems];
  }

  /**
   * Get items by status
   */
  public getItemsByStatus(status: QueueStatus): QueueItem[] {
    return this.queueItems.filter((item) => item.status === status);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.queueItems = [];
  }
}

/**
 * Factory function to create and register the queue tree provider
 */
export function createQueueTreeProvider(
  context: vscode.ExtensionContext,
  options?: QueueTreeProviderOptions
): QueueTreeProvider {
  const provider = new QueueTreeProvider(options);

  // Register the tree data provider
  const treeView = vscode.window.createTreeView(VIEWS.queue, {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: false,
  });

  // Pause/resume polling based on view visibility
  treeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      provider.resumePolling();
    } else {
      provider.pausePolling();
    }
  });

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.queue.refresh', () => {
      provider.refresh();
    })
  );

  // Register view mode commands
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.queue.viewFlat', () => {
      provider.setViewMode('flat');
    }),
    vscode.commands.registerCommand('generacy.queue.viewByStatus', () => {
      provider.setViewMode('byStatus');
    }),
    vscode.commands.registerCommand('generacy.queue.viewByRepository', () => {
      provider.setViewMode('byRepository');
    }),
    vscode.commands.registerCommand('generacy.queue.viewByAssignee', () => {
      provider.setViewMode('byAssignee');
    })
  );

  // Register filter commands
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.queue.filterByStatus', async () => {
      const statuses: QueueStatus[] = ['pending', 'running', 'completed', 'failed', 'cancelled'];
      const selected = await vscode.window.showQuickPick(
        [
          { label: 'All Statuses', value: undefined },
          ...statuses.map((s) => ({ label: s.charAt(0).toUpperCase() + s.slice(1), value: s })),
        ],
        { placeHolder: 'Filter by status' }
      );
      if (selected !== undefined) {
        provider.setStatusFilter(selected.value as QueueStatus | undefined);
      }
    }),
    vscode.commands.registerCommand('generacy.queue.clearFilters', () => {
      provider.clearFilters();
    })
  );

  // Add to disposables
  context.subscriptions.push(provider);
  context.subscriptions.push(treeView);

  return provider;
}
