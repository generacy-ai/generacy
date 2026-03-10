/**
 * QueueTreeProvider - Tree data provider for the Workflow Queue view.
 * Provides queue items with SSE real-time updates, API polling fallback,
 * filtering, and grouped display modes.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import { queueApi, QueueFilterOptions } from '../../../api/endpoints/queue';
import { getSSEManager } from '../../../api/sse';
import type {
  QueueItem,
  QueueItemProgressSummary,
  QueueStatus,
  SSEEvent,
  WorkflowPhaseEventData,
} from '../../../api/types';
import { VIEWS } from '../../../constants';
import type { ProjectConfigService } from '../../../services/project-config-service';
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
 * - SSE real-time updates via queue channel (with 200ms debouncing)
 * - API polling fallback for data integrity
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
  private sseDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private workflowsDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isLoading = false;
  private loadError: Error | undefined;
  private viewMode: QueueViewMode;
  private activeFilters: QueueFilterOptions = {};
  private readonly pollingInterval: number;
  private readonly pageSize: number;
  private isPaused = false;
  private elapsedTimer: ReturnType<typeof setInterval> | undefined;

  /** Progress summaries keyed by job ID, updated from workflows SSE and REST responses */
  private progressSummaries = new Map<string, QueueItemProgressSummary>();

  /** Optional project config for default repository scoping */
  private readonly projectConfig: ProjectConfigService | undefined;

  /** Whether the project-scoped filter is active (true = show project jobs only) */
  private projectScopeActive = false;

  constructor(options: QueueTreeProviderOptions = {}, projectConfig?: ProjectConfigService) {
    const logger = getLogger();
    logger.debug('QueueTreeProvider initialized');

    this.pollingInterval = options.pollingInterval ?? 30000; // Default 30s
    this.viewMode = options.viewMode ?? 'flat';
    this.pageSize = options.pageSize ?? 50;
    this.projectConfig = projectConfig;

    // Apply default project-scoped filter if config is available
    if (projectConfig?.isConfigured) {
      this.applyProjectFilter();
    }

    // React to project config changes (file created, modified, or deleted)
    if (projectConfig) {
      this.disposables.push(
        projectConfig.onDidChange((config) => {
          if (config && this.projectScopeActive) {
            // Config changed — update the repository filter value
            this.applyProjectFilter();
          } else if (!config && this.projectScopeActive) {
            // Config was deleted — clear project scope
            this.projectScopeActive = false;
            this.activeFilters.repository = undefined;
            void this.fetchQueue();
          }
        })
      );
    }

    // Listen for authentication changes
    const authService = getAuthService();
    this.disposables.push(
      authService.onDidChange((event) => {
        if (event.newState.isAuthenticated) {
          logger.info('User authenticated, starting queue polling and SSE');
          this.startPolling();
          this.subscribeSSE();
        } else {
          logger.info('User logged out, stopping queue polling and SSE');
          this.stopPolling();
          this.queueItems = [];
          this._onDidChangeTreeData.fire();
        }
      })
    );

    // Start polling and SSE if already authenticated
    if (authService.isAuthenticated()) {
      this.startPolling();
      this.subscribeSSE();
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
        return this.queueItems.map((item) => new QueueTreeItem(item, this.progressSummaries.get(item.id)));

      case 'byStatus':
        return this.getStatusGroups();

      case 'byRepository':
        return this.getRepositoryGroups();

      case 'byAssignee':
        return this.getAssigneeGroups();

      default:
        return this.queueItems.map((item) => new QueueTreeItem(item, this.progressSummaries.get(item.id)));
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

    // Sort by priority: running > waiting > pending > failed > completed > cancelled
    const statusOrder: QueueStatus[] = ['running', 'waiting', 'pending', 'failed', 'completed', 'cancelled'];

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

    return filtered.map((item) => new QueueTreeItem(item, this.progressSummaries.get(item.id)));
  }

  // ==========================================================================
  // SSE Subscription
  // ==========================================================================

  /**
   * Subscribe to SSE queue and workflows channels for real-time updates
   */
  private subscribeSSE(): void {
    const logger = getLogger();
    const sseManager = getSSEManager();

    const queueSubscription = sseManager.subscribe('queue', (event: SSEEvent) => {
      this.handleSSEEvent(event);
    });
    this.disposables.push(queueSubscription);
    logger.debug('Subscribed to SSE queue channel');

    const workflowsSubscription = sseManager.subscribe('workflows', (event: SSEEvent) => {
      this.handleWorkflowEvent(event);
    });
    this.disposables.push(workflowsSubscription);
    logger.debug('Subscribed to SSE workflows channel');
  }

  /**
   * Handle an SSE event on the queue channel
   */
  private handleSSEEvent(event: SSEEvent): void {
    const logger = getLogger();
    const itemData = event.data as Partial<QueueItem> & { id?: string; itemId?: string };
    const itemId = itemData.id ?? itemData.itemId;

    switch (event.event) {
      case 'queue:item:added': {
        if (!itemId) break;
        // Avoid duplicates
        const exists = this.queueItems.some((i) => i.id === itemId);
        if (!exists && this.isCompleteQueueItem(itemData)) {
          this.queueItems.push(itemData as QueueItem);
          logger.debug(`Queue item added via SSE: ${itemId}`);
          this.debouncedRefreshTree();
        }
        break;
      }

      case 'queue:item:removed': {
        if (!itemId) break;
        const removeIdx = this.queueItems.findIndex((i) => i.id === itemId);
        if (removeIdx >= 0) {
          this.queueItems.splice(removeIdx, 1);
          logger.debug(`Queue item removed via SSE: ${itemId}`);
          this.debouncedRefreshTree();
        }
        break;
      }

      case 'queue:updated': {
        if (!itemId) break;
        const updateIdx = this.queueItems.findIndex((i) => i.id === itemId);
        if (updateIdx >= 0) {
          const oldItem = this.queueItems[updateIdx]!;
          const updatedItem = { ...oldItem, ...itemData } as QueueItem;
          // Only refresh if key fields changed
          if (
            oldItem.status !== updatedItem.status ||
            oldItem.priority !== updatedItem.priority ||
            oldItem.assigneeId !== updatedItem.assigneeId ||
            oldItem.startedAt !== updatedItem.startedAt ||
            oldItem.completedAt !== updatedItem.completedAt ||
            oldItem.waitingFor !== updatedItem.waitingFor
          ) {
            this.queueItems[updateIdx] = updatedItem;
            logger.debug(`Queue item updated via SSE: ${itemId}`);
            this.debouncedRefreshTree();
          }
        }
        break;
      }

      default:
        logger.debug(`Unknown queue SSE event: ${event.event}`);
    }
  }

  /**
   * Check if a partial queue item has all required fields
   */
  private isCompleteQueueItem(data: Partial<QueueItem>): data is QueueItem {
    return !!(data.id && data.workflowId && data.workflowName && data.status && data.priority && data.queuedAt);
  }

  /**
   * Debounce tree refresh to avoid rapid successive updates from SSE
   */
  private debouncedRefreshTree(): void {
    if (this.sseDebounceTimer) {
      clearTimeout(this.sseDebounceTimer);
    }
    this.sseDebounceTimer = setTimeout(() => {
      this.sseDebounceTimer = undefined;
      this.updateElapsedTimer();
      this._onDidChangeTreeData.fire();
    }, 200);
  }

  /**
   * Handle an SSE event on the workflows channel.
   * Updates progress summaries for tracked jobs and fires debounced tree refresh.
   */
  private handleWorkflowEvent(event: SSEEvent): void {
    const logger = getLogger();

    switch (event.event) {
      case 'workflow:progress': {
        // Full progress snapshot — extract summary and store
        const data = event.data as {
          jobId?: string;
          currentPhaseIndex?: number;
          totalPhases?: number;
          completedPhases?: number;
          skippedPhases?: number;
          phases?: Array<{ name?: string; status?: string }>;
        };
        const jobId = data.jobId;
        if (!jobId) break;

        // Ignore events for jobs not in our queue
        if (!this.queueItems.some((i) => i.id === jobId)) break;

        const currentPhaseIndex = data.currentPhaseIndex ?? 0;
        const currentPhaseName = data.phases?.[currentPhaseIndex]?.name;

        const summary: QueueItemProgressSummary = {
          currentPhase: currentPhaseName,
          phaseProgress: `Phase ${(data.completedPhases ?? 0) + 1}/${data.totalPhases ?? 0}`,
          totalPhases: data.totalPhases,
          completedPhases: data.completedPhases,
          skippedPhases: data.skippedPhases,
        };

        this.progressSummaries.set(jobId, summary);
        logger.debug(`Workflow progress updated for job ${jobId}`);
        this.debouncedRefreshTreeForWorkflows();
        break;
      }

      case 'workflow:phase:start':
      case 'workflow:phase:complete': {
        const data = event.data as WorkflowPhaseEventData;
        const jobId = data.jobId;
        if (!jobId) break;

        // Ignore events for jobs not in our queue
        if (!this.queueItems.some((i) => i.id === jobId)) break;

        // Update existing summary or create a new one from the phase event
        const existing = this.progressSummaries.get(jobId);
        const phaseName = data.phase?.name;
        const isStart = event.event === 'workflow:phase:start';

        const summary: QueueItemProgressSummary = {
          currentPhase: isStart ? phaseName : existing?.currentPhase,
          phaseProgress: `Phase ${data.phaseIndex + 1}/${data.totalPhases}`,
          totalPhases: data.totalPhases ?? existing?.totalPhases,
          completedPhases: isStart
            ? existing?.completedPhases
            : (existing?.completedPhases ?? 0) + 1,
          skippedPhases: existing?.skippedPhases,
        };

        this.progressSummaries.set(jobId, summary);
        logger.debug(`Workflow phase ${event.event} for job ${jobId}: ${phaseName}`);
        this.debouncedRefreshTreeForWorkflows();
        break;
      }

      default:
        // Ignore step-level and other workflow events at the tree level
        break;
    }
  }

  /**
   * Debounce tree refresh for workflow events (separate timer from queue SSE debounce)
   */
  private debouncedRefreshTreeForWorkflows(): void {
    if (this.workflowsDebounceTimer) {
      clearTimeout(this.workflowsDebounceTimer);
    }
    this.workflowsDebounceTimer = setTimeout(() => {
      this.workflowsDebounceTimer = undefined;
      this._onDidChangeTreeData.fire();
    }, 200);
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

      // Populate progress summaries from REST response (initial/fallback data)
      for (const item of response.items) {
        if (item.progress) {
          this.progressSummaries.set(item.id, item.progress);
        }
      }

      // Update elapsed timer based on current running state
      this.updateElapsedTimer();

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
        oldItem.completedAt !== newItem.completedAt ||
        oldItem.waitingFor !== newItem.waitingFor
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
   * Clear all filters. If project config is available, re-applies the
   * project-scoped repository filter as the baseline.
   */
  public clearFilters(): void {
    const logger = getLogger();
    logger.info('Clearing all queue filters');

    this.activeFilters = {};

    // Re-apply project scope if it was active
    if (this.projectScopeActive && this.projectConfig?.isConfigured) {
      this.applyProjectFilter();
      return; // applyProjectFilter triggers fetchQueue
    }

    void this.fetchQueue();
  }

  /**
   * Toggle between project-scoped and all-org job views.
   * When project scope is active, only jobs matching the project's repository
   * are shown. When inactive, all org jobs are visible.
   */
  public toggleProjectScope(): void {
    const logger = getLogger();

    if (this.projectScopeActive) {
      // Switch to showing all org jobs
      this.projectScopeActive = false;
      this.activeFilters.repository = undefined;
      logger.info('Showing all org jobs');
    } else if (this.projectConfig?.isConfigured) {
      // Switch to showing project jobs only
      this.applyProjectFilter();
      logger.info('Showing project jobs only');
      return; // applyProjectFilter triggers fetchQueue
    }

    void this.fetchQueue();
  }

  /**
   * Whether the project-scoped filter is currently active
   */
  public get isProjectScoped(): boolean {
    return this.projectScopeActive;
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

  /**
   * Get the progress summary for a specific job
   */
  public getProgressSummary(jobId: string): QueueItemProgressSummary | undefined {
    return this.progressSummaries.get(jobId);
  }

  // ==========================================================================
  // Project Scoping
  // ==========================================================================

  /**
   * Apply the project-scoped repository filter using the project config's
   * `reposPrimary` value. Falls back to project name if no repo is configured.
   */
  private applyProjectFilter(): void {
    const repoFilter = this.projectConfig?.reposPrimary ?? this.projectConfig?.projectName;
    if (repoFilter) {
      this.projectScopeActive = true;
      this.activeFilters.repository = repoFilter;
      void this.fetchQueue();
    }
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Start or stop the elapsed time refresh timer based on whether any jobs are running.
   * When running jobs exist, fires a tree refresh every 10 seconds so elapsed time
   * descriptions stay current. Clears the timer when no jobs are running.
   */
  private updateElapsedTimer(): void {
    const hasRunning = this.queueItems.some((i) => i.status === 'running' || i.status === 'waiting');
    if (hasRunning && !this.elapsedTimer) {
      this.elapsedTimer = setInterval(() => {
        this._onDidChangeTreeData.fire();
      }, 10_000);
    } else if (!hasRunning && this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

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
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
    if (this.sseDebounceTimer) {
      clearTimeout(this.sseDebounceTimer);
    }
    if (this.workflowsDebounceTimer) {
      clearTimeout(this.workflowsDebounceTimer);
    }
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.queueItems = [];
    this.progressSummaries.clear();
  }
}

/**
 * Factory function to create and register the queue tree provider
 */
export function createQueueTreeProvider(
  context: vscode.ExtensionContext,
  options?: QueueTreeProviderOptions,
  projectConfig?: ProjectConfigService
): QueueTreeProvider {
  const provider = new QueueTreeProvider(options, projectConfig);

  // Set initial project scope context key
  void vscode.commands.executeCommand(
    'setContext',
    'generacy.queue.isProjectScoped',
    provider.isProjectScoped,
  );

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
      const statuses: QueueStatus[] = ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'];
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
    }),
    vscode.commands.registerCommand('generacy.queue.toggleProjectScope', () => {
      provider.toggleProjectScope();
      // Update context key so the UI label/icon can react
      void vscode.commands.executeCommand(
        'setContext',
        'generacy.queue.isProjectScoped',
        provider.isProjectScoped,
      );
    })
  );

  // Add to disposables
  context.subscriptions.push(provider);
  context.subscriptions.push(treeView);

  return provider;
}
