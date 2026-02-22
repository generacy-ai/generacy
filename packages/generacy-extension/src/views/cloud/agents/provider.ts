/**
 * AgentTreeProvider - Tree data provider for the Agent monitoring view.
 * Provides agent status with SSE real-time updates, polling fallback, and grouped display.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import { agentsApi } from '../../../api/endpoints/agents';
import { getSSEManager } from '../../../api/sse';
import type { Agent, AgentDisplayStatus, SSEEvent } from '../../../api/types';
import { VIEWS, CLOUD_COMMANDS } from '../../../constants';
import {
  AgentTreeItem,
  AgentGroupItem,
  AgentEmptyItem,
  AgentLoadingItem,
  AgentErrorItem,
  AgentExplorerItem,
  getDisplayStatus,
} from './tree-item';
import { registerAgentActions } from './actions';

/**
 * View mode for agent display
 */
export type AgentViewMode = 'flat' | 'byStatus';

/**
 * Agent tree provider options
 */
export interface AgentTreeProviderOptions {
  /** Polling interval in milliseconds (default: 60000 = 60s) */
  pollingInterval?: number;
  /** Initial view mode */
  viewMode?: AgentViewMode;
  /** Page size for API requests */
  pageSize?: number;
}

/** Status display order: available first, then busy, then offline */
const STATUS_ORDER: AgentDisplayStatus[] = ['available', 'busy', 'offline'];

/**
 * AgentTreeProvider implements TreeDataProvider for agent monitoring.
 *
 * Features:
 * - SSE real-time updates via agents channel
 * - Polling fallback for data integrity
 * - Two view modes: flat and grouped by status
 * - Loading, error, and empty states
 * - Auth-reactive start/stop
 */
export class AgentTreeProvider
  implements vscode.TreeDataProvider<AgentExplorerItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    AgentExplorerItem | undefined | null | void
  >();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private agents: Agent[] = [];
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private sseDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private isLoading = false;
  private loadError: Error | undefined;
  private viewMode: AgentViewMode;
  private readonly pollingInterval: number;
  private readonly pageSize: number;
  private isPaused = false;

  constructor(options: AgentTreeProviderOptions = {}) {
    const logger = getLogger();
    logger.debug('AgentTreeProvider initialized');

    this.pollingInterval = options.pollingInterval ?? 60000; // Default 60s
    this.viewMode = options.viewMode ?? 'byStatus';
    this.pageSize = options.pageSize ?? 50;

    // Listen for authentication changes
    const authService = getAuthService();
    this.disposables.push(
      authService.onDidChange((event) => {
        if (event.newState.isAuthenticated) {
          logger.info('User authenticated, starting agent polling and SSE');
          this.startPolling();
          this.subscribeSSE();
        } else {
          logger.info('User logged out, stopping agent polling and SSE');
          this.stopPolling();
          this.agents = [];
          this._onDidChangeTreeData.fire();
        }
      })
    );

    // Start if already authenticated
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
  public getTreeItem(element: AgentExplorerItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a tree item
   */
  public async getChildren(element?: AgentExplorerItem): Promise<AgentExplorerItem[]> {
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      return [new AgentEmptyItem()];
    }

    // Root level
    if (!element) {
      if (this.isLoading && this.agents.length === 0) {
        return [new AgentLoadingItem()];
      }

      if (this.loadError && this.agents.length === 0) {
        return [new AgentErrorItem(this.loadError)];
      }

      return this.getRootChildren();
    }

    // Group level — return agents filtered by that group's status
    if (element instanceof AgentGroupItem) {
      return this.getAgentsForStatus(element.status);
    }

    return [];
  }

  /**
   * Get parent of a tree item (for reveal support)
   */
  public getParent(element: AgentExplorerItem): AgentExplorerItem | undefined {
    if (element instanceof AgentTreeItem && this.viewMode === 'byStatus') {
      const displayStatus = getDisplayStatus(element.agent.status);
      const count = this.agents.filter(
        (a) => getDisplayStatus(a.status) === displayStatus
      ).length;
      return new AgentGroupItem(displayStatus, count);
    }
    return undefined;
  }

  // ==========================================================================
  // Root Children Methods
  // ==========================================================================

  /**
   * Get children for root level based on view mode
   */
  private getRootChildren(): AgentExplorerItem[] {
    if (this.agents.length === 0) {
      return [new AgentEmptyItem()];
    }

    switch (this.viewMode) {
      case 'flat':
        return this.getFlatList();
      case 'byStatus':
        return this.getStatusGroups();
      default:
        return this.getFlatList();
    }
  }

  /**
   * Get flat list of agents sorted by status then name
   */
  private getFlatList(): AgentTreeItem[] {
    const sorted = [...this.agents].sort((a, b) => {
      const statusA = STATUS_ORDER.indexOf(getDisplayStatus(a.status));
      const statusB = STATUS_ORDER.indexOf(getDisplayStatus(b.status));
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      return a.name.localeCompare(b.name);
    });

    return sorted.map((agent) => new AgentTreeItem(agent));
  }

  /**
   * Get status group items with counts
   */
  private getStatusGroups(): AgentGroupItem[] {
    const counts = new Map<AgentDisplayStatus, number>();

    for (const agent of this.agents) {
      const status = getDisplayStatus(agent.status);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }

    return STATUS_ORDER
      .filter((status) => counts.has(status))
      .map((status) => new AgentGroupItem(status, counts.get(status)!));
  }

  /**
   * Get agent tree items for a specific display status
   */
  private getAgentsForStatus(status: AgentDisplayStatus): AgentTreeItem[] {
    return this.agents
      .filter((agent) => getDisplayStatus(agent.status) === status)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((agent) => new AgentTreeItem(agent));
  }

  // ==========================================================================
  // SSE Subscription
  // ==========================================================================

  /**
   * Subscribe to SSE agents channel for real-time updates
   */
  private subscribeSSE(): void {
    const logger = getLogger();
    const sseManager = getSSEManager();

    const subscription = sseManager.subscribe('agents', (event: SSEEvent) => {
      this.handleSSEEvent(event);
    });

    this.disposables.push(subscription);
    logger.debug('Subscribed to SSE agents channel');
  }

  /**
   * Handle an SSE event on the agents channel
   */
  private handleSSEEvent(event: SSEEvent): void {
    const logger = getLogger();
    const agentData = event.data as Partial<Agent> & { id?: string; agentId?: string };
    const agentId = agentData.id ?? agentData.agentId;

    switch (event.event) {
      case 'agent:connected': {
        if (!agentId) break;
        const existing = this.agents.findIndex((a) => a.id === agentId);
        if (existing >= 0 && agentData) {
          this.agents[existing] = { ...this.agents[existing], ...agentData } as Agent;
        } else if (agentData && this.isCompleteAgent(agentData)) {
          this.agents.push(agentData as Agent);
        }
        logger.debug(`Agent connected: ${agentId}`);
        this.debouncedRefreshTree();
        break;
      }

      case 'agent:disconnected': {
        if (!agentId) break;
        const idx = this.agents.findIndex((a) => a.id === agentId);
        if (idx >= 0) {
          this.agents[idx] = {
            ...this.agents[idx],
            status: 'disconnected',
          } as Agent;
        }
        logger.debug(`Agent disconnected: ${agentId}`);
        this.debouncedRefreshTree();
        break;
      }

      case 'agent:status': {
        if (!agentId) break;
        const statusIdx = this.agents.findIndex((a) => a.id === agentId);
        if (statusIdx >= 0) {
          this.agents[statusIdx] = {
            ...this.agents[statusIdx],
            ...agentData,
          } as Agent;
        }
        logger.debug(`Agent status updated: ${agentId}`);
        this.debouncedRefreshTree();
        break;
      }

      default:
        logger.debug(`Unknown agent SSE event: ${event.event}`);
    }
  }

  /**
   * Check if a partial agent object has all required fields
   */
  private isCompleteAgent(data: Partial<Agent>): data is Agent {
    return !!(data.id && data.name && data.type && data.status && data.capabilities && data.lastSeen);
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
      this._onDidChangeTreeData.fire();
    }, 200);
  }

  // ==========================================================================
  // Polling Methods
  // ==========================================================================

  /**
   * Start polling for agent updates
   */
  public startPolling(): void {
    if (this.pollingTimer) {
      return;
    }

    const logger = getLogger();
    logger.debug(`Starting agent polling (interval: ${this.pollingInterval}ms)`);

    // Fetch immediately
    void this.fetchAgents();

    // Set up interval for subsequent fetches
    this.pollingTimer = setInterval(() => {
      if (!this.isPaused) {
        void this.fetchAgents();
      }
    }, this.pollingInterval);
  }

  /**
   * Stop polling for agent updates
   */
  public stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;

      const logger = getLogger();
      logger.debug('Agent polling stopped');
    }
  }

  /**
   * Pause polling (e.g., when view is not visible)
   */
  public pausePolling(): void {
    this.isPaused = true;
    const logger = getLogger();
    logger.debug('Agent polling paused');
  }

  /**
   * Resume polling
   */
  public resumePolling(): void {
    this.isPaused = false;
    const logger = getLogger();
    logger.debug('Agent polling resumed');

    // Fetch immediately on resume
    void this.fetchAgents();
  }

  /**
   * Fetch agents from API
   */
  private async fetchAgents(): Promise<void> {
    const logger = getLogger();
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      logger.debug('Not authenticated, skipping agent fetch');
      return;
    }

    if (this.isLoading) {
      logger.debug('Already loading, skipping agent fetch');
      return;
    }

    this.isLoading = true;

    // Only fire tree update for initial load
    if (this.agents.length === 0) {
      this._onDidChangeTreeData.fire();
    }

    try {
      logger.debug('Fetching agents');

      const response = await agentsApi.getAgents({
        pageSize: this.pageSize,
      });

      const hasChanges = this.hasAgentsChanged(response.items);

      this.agents = response.items;
      this.loadError = undefined;

      if (hasChanges) {
        logger.debug(`Agents updated: ${response.items.length} agents`);
        this._onDidChangeTreeData.fire();
      }
    } catch (error) {
      logger.error('Failed to fetch agents', error);
      this.loadError = error instanceof Error ? error : new Error(String(error));

      if (this.agents.length === 0) {
        this._onDidChangeTreeData.fire();
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Check if agent data has changed
   */
  private hasAgentsChanged(newAgents: Agent[]): boolean {
    if (newAgents.length !== this.agents.length) {
      return true;
    }

    for (const newAgent of newAgents) {
      const oldAgent = this.agents.find((a) => a.id === newAgent.id);

      if (!oldAgent) {
        return true;
      }

      if (
        oldAgent.status !== newAgent.status ||
        oldAgent.name !== newAgent.name ||
        oldAgent.metadata.workflowId !== newAgent.metadata.workflowId
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
   * Manually refresh agents
   */
  public refresh(): void {
    const logger = getLogger();
    logger.info('Manually refreshing agents');
    void this.fetchAgents();
  }

  /**
   * Set the view mode
   */
  public setViewMode(mode: AgentViewMode): void {
    const logger = getLogger();
    logger.info(`Setting agent view mode: ${mode}`);

    this.viewMode = mode;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current view mode
   */
  public getViewMode(): AgentViewMode {
    return this.viewMode;
  }

  /**
   * Get an agent by ID
   */
  public getAgentById(id: string): Agent | undefined {
    return this.agents.find((agent) => agent.id === id);
  }

  /**
   * Get all agents
   */
  public getAllAgents(): Agent[] {
    return [...this.agents];
  }

  // ==========================================================================
  // Dispose
  // ==========================================================================

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopPolling();
    if (this.sseDebounceTimer) {
      clearTimeout(this.sseDebounceTimer);
    }
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.agents = [];
  }
}

/**
 * Factory function to create and register the agent tree provider
 */
export function createAgentTreeProvider(
  context: vscode.ExtensionContext,
  options?: AgentTreeProviderOptions
): AgentTreeProvider {
  const provider = new AgentTreeProvider(options);

  // Register the tree data provider
  const treeView = vscode.window.createTreeView(VIEWS.agents, {
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
    vscode.commands.registerCommand(CLOUD_COMMANDS.refreshAgents, () => {
      provider.refresh();
    })
  );

  // Register agent action commands (view logs, view modes)
  registerAgentActions(context, provider);

  // Add to disposables
  context.subscriptions.push(provider);
  context.subscriptions.push(treeView);

  return provider;
}
