/**
 * IntegrationsTreeProvider - Tree data provider for the Integrations view.
 * Provides integration items with API polling and connection status display.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils/logger';
import { getAuthService } from '../../../api/auth';
import {
  integrationsApi,
  IntegrationDetails,
  Webhook,
  GitHubRepository,
} from '../../../api/endpoints/integrations';
import { Integration, IntegrationType } from '../../../api/types';
import {
  IntegrationTreeItem,
  IntegrationTypeGroupItem,
  IntegrationEmptyItem,
  IntegrationLoadingItem,
  IntegrationErrorItem,
  IntegrationExplorerItem,
  RepositoryTreeItem,
  WebhookTreeItem,
  WebhookSectionItem,
  isIntegrationTreeItem,
  isWebhookSectionItem,
} from './tree-item';

/**
 * View mode for integrations display
 */
export type IntegrationsViewMode = 'flat' | 'byType';

/**
 * Integrations tree provider options
 */
export interface IntegrationsTreeProviderOptions {
  /** Polling interval in milliseconds (default: 60000 = 60s) */
  pollingInterval?: number;
  /** Initial view mode */
  viewMode?: IntegrationsViewMode;
}

/**
 * IntegrationsTreeProvider implements TreeDataProvider for integration items.
 *
 * Features:
 * - API polling for status updates
 * - View modes (flat, grouped by type)
 * - Loading and error states
 * - Expandable integrations showing connected repos/webhooks
 */
export class IntegrationsTreeProvider
  implements vscode.TreeDataProvider<IntegrationExplorerItem>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    IntegrationExplorerItem | undefined | null | void
  >();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly disposables: vscode.Disposable[] = [];
  private integrations: Integration[] = [];
  private integrationDetails: Map<IntegrationType, IntegrationDetails> = new Map();
  private webhooks: Map<IntegrationType, Webhook[]> = new Map();
  private pollingTimer: ReturnType<typeof setInterval> | undefined;
  private isLoading = false;
  private loadError: Error | undefined;
  private viewMode: IntegrationsViewMode;
  private readonly pollingInterval: number;
  private isPaused = false;

  constructor(options: IntegrationsTreeProviderOptions = {}) {
    const logger = getLogger();
    logger.debug('IntegrationsTreeProvider initialized');

    this.pollingInterval = options.pollingInterval ?? 60000; // Default 60s
    this.viewMode = options.viewMode ?? 'flat';

    // Listen for authentication changes
    const authService = getAuthService();
    this.disposables.push(
      authService.onDidChange((event) => {
        if (event.newState.isAuthenticated) {
          logger.info('User authenticated, starting integrations polling');
          this.startPolling();
        } else {
          logger.info('User logged out, stopping integrations polling');
          this.stopPolling();
          this.integrations = [];
          this.integrationDetails.clear();
          this.webhooks.clear();
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
  public getTreeItem(element: IntegrationExplorerItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for a tree item
   */
  public async getChildren(element?: IntegrationExplorerItem): Promise<IntegrationExplorerItem[]> {
    const authService = getAuthService();

    // Check authentication
    if (!authService.isAuthenticated()) {
      return [new IntegrationEmptyItem('Sign in to view integrations')];
    }

    // Root level
    if (!element) {
      // Show loading state
      if (this.isLoading && this.integrations.length === 0) {
        return [new IntegrationLoadingItem()];
      }

      // Show error state
      if (this.loadError && this.integrations.length === 0) {
        return [new IntegrationErrorItem(this.loadError)];
      }

      // Return items based on view mode
      return this.getRootChildren();
    }

    // Integration type group level
    if (element instanceof IntegrationTypeGroupItem) {
      return element.integrations.map((i) => new IntegrationTreeItem(i));
    }

    // Connected integration - show children (repos, webhooks)
    if (isIntegrationTreeItem(element) && element.integration.status === 'connected') {
      return this.getIntegrationChildren(element.integration);
    }

    // Webhook section - show webhooks
    if (isWebhookSectionItem(element)) {
      return this.getWebhookChildren(element.integrationType);
    }

    return [];
  }

  /**
   * Get parent of a tree item (for reveal support)
   */
  public getParent(element: IntegrationExplorerItem): IntegrationExplorerItem | undefined {
    if (element instanceof IntegrationTreeItem && this.viewMode === 'byType') {
      const type = element.integration.type;
      const typeIntegrations = this.integrations.filter((i) => i.type === type);
      return new IntegrationTypeGroupItem(type, typeIntegrations);
    }

    if (element instanceof RepositoryTreeItem || element instanceof WebhookSectionItem) {
      // Find parent integration
      const integration = this.integrations.find(
        (i) =>
          i.type === (element instanceof WebhookSectionItem ? element.integrationType : 'github')
      );
      if (integration) {
        return new IntegrationTreeItem(integration);
      }
    }

    return undefined;
  }

  // ==========================================================================
  // Children Methods
  // ==========================================================================

  /**
   * Get children for root level based on view mode
   */
  private getRootChildren(): IntegrationExplorerItem[] {
    if (this.integrations.length === 0) {
      return [new IntegrationEmptyItem()];
    }

    switch (this.viewMode) {
      case 'flat':
        return this.integrations.map((i) => new IntegrationTreeItem(i));

      case 'byType':
        return this.getTypeGroups();

      default:
        return this.integrations.map((i) => new IntegrationTreeItem(i));
    }
  }

  /**
   * Get type filter groups
   */
  private getTypeGroups(): IntegrationTypeGroupItem[] {
    const typeMap = new Map<IntegrationType, Integration[]>();

    for (const integration of this.integrations) {
      const existing = typeMap.get(integration.type) ?? [];
      existing.push(integration);
      typeMap.set(integration.type, existing);
    }

    return Array.from(typeMap.entries()).map(
      ([type, integrations]) => new IntegrationTypeGroupItem(type, integrations)
    );
  }

  /**
   * Get children for a connected integration
   */
  private async getIntegrationChildren(
    integration: Integration
  ): Promise<IntegrationExplorerItem[]> {
    const children: IntegrationExplorerItem[] = [];
    const details = this.integrationDetails.get(integration.type);

    // For GitHub, show connected repositories
    if (integration.type === 'github' && details?.github) {
      const repos = details.github.repositories;
      if (repos.length > 0) {
        children.push(...repos.map((r) => new RepositoryTreeItem(r.fullName, r.isPrivate)));
      }
    }

    // Show webhooks section if we have any
    const webhookList = this.webhooks.get(integration.type);
    if (webhookList && webhookList.length > 0) {
      children.push(new WebhookSectionItem(integration.type, webhookList.length));
    }

    return children;
  }

  /**
   * Get webhook children for a webhook section
   */
  private getWebhookChildren(type: IntegrationType): WebhookTreeItem[] {
    const webhookList = this.webhooks.get(type) ?? [];
    return webhookList.map(
      (w) =>
        new WebhookTreeItem(w.id, w.url, w.events, w.active, type, w.lastDeliveryStatus)
    );
  }

  // ==========================================================================
  // Polling Methods
  // ==========================================================================

  /**
   * Start polling for integration updates
   */
  public startPolling(): void {
    if (this.pollingTimer) {
      return; // Already polling
    }

    const logger = getLogger();
    logger.debug(`Starting integrations polling (interval: ${this.pollingInterval}ms)`);

    // Fetch immediately
    void this.fetchIntegrations();

    // Set up interval for subsequent fetches
    this.pollingTimer = setInterval(() => {
      if (!this.isPaused) {
        void this.fetchIntegrations();
      }
    }, this.pollingInterval);
  }

  /**
   * Stop polling for integration updates
   */
  public stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;

      const logger = getLogger();
      logger.debug('Integrations polling stopped');
    }
  }

  /**
   * Pause polling (e.g., when view is not visible)
   */
  public pausePolling(): void {
    this.isPaused = true;
    const logger = getLogger();
    logger.debug('Integrations polling paused');
  }

  /**
   * Resume polling
   */
  public resumePolling(): void {
    this.isPaused = false;
    const logger = getLogger();
    logger.debug('Integrations polling resumed');

    // Fetch immediately on resume
    void this.fetchIntegrations();
  }

  /**
   * Fetch integrations from API
   */
  private async fetchIntegrations(): Promise<void> {
    const logger = getLogger();
    const authService = getAuthService();

    if (!authService.isAuthenticated()) {
      logger.debug('Not authenticated, skipping integrations fetch');
      return;
    }

    if (this.isLoading) {
      logger.debug('Already loading, skipping integrations fetch');
      return;
    }

    this.isLoading = true;

    // Only fire tree update for initial load
    if (this.integrations.length === 0) {
      this._onDidChangeTreeData.fire();
    }

    try {
      logger.debug('Fetching integrations');

      const newIntegrations = await integrationsApi.getIntegrations();

      // Check if data has changed
      const hasChanges = this.hasIntegrationsChanged(newIntegrations);

      this.integrations = newIntegrations;
      this.loadError = undefined;

      // Fetch details for connected integrations
      await this.fetchIntegrationDetails(newIntegrations);

      if (hasChanges) {
        logger.debug(`Integrations updated: ${newIntegrations.length} items`);
        this._onDidChangeTreeData.fire();
      }
    } catch (error) {
      logger.error('Failed to fetch integrations', error);
      this.loadError = error instanceof Error ? error : new Error(String(error));

      // Only update tree if this is the first error or we had data
      if (this.integrations.length === 0) {
        this._onDidChangeTreeData.fire();
      }
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Fetch detailed info and webhooks for connected integrations
   */
  private async fetchIntegrationDetails(integrations: Integration[]): Promise<void> {
    const logger = getLogger();
    const connected = integrations.filter((i) => i.status === 'connected');

    for (const integration of connected) {
      try {
        // Fetch details
        const details = await integrationsApi.getIntegrationDetails(integration.type);
        this.integrationDetails.set(integration.type, details);

        // Fetch webhooks
        const webhookList = await integrationsApi.getWebhooks(integration.type);
        this.webhooks.set(integration.type, webhookList);
      } catch (error) {
        logger.warn(`Failed to fetch details for ${integration.type}`, error);
      }
    }
  }

  /**
   * Check if integrations data has changed
   */
  private hasIntegrationsChanged(newIntegrations: Integration[]): boolean {
    if (newIntegrations.length !== this.integrations.length) {
      return true;
    }

    for (const newItem of newIntegrations) {
      const oldItem = this.integrations.find((i) => i.type === newItem.type);

      if (!oldItem) {
        return true;
      }

      if (
        oldItem.status !== newItem.status ||
        oldItem.accountName !== newItem.accountName ||
        oldItem.error !== newItem.error
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
   * Manually refresh the integrations
   */
  public refresh(): void {
    const logger = getLogger();
    logger.info('Manually refreshing integrations');
    void this.fetchIntegrations();
  }

  /**
   * Set the view mode
   */
  public setViewMode(mode: IntegrationsViewMode): void {
    const logger = getLogger();
    logger.info(`Setting integrations view mode: ${mode}`);

    this.viewMode = mode;
    this._onDidChangeTreeData.fire();
  }

  /**
   * Get the current view mode
   */
  public getViewMode(): IntegrationsViewMode {
    return this.viewMode;
  }

  /**
   * Get an integration by type
   */
  public getIntegrationByType(type: IntegrationType): Integration | undefined {
    return this.integrations.find((i) => i.type === type);
  }

  /**
   * Get integration details by type
   */
  public getIntegrationDetails(type: IntegrationType): IntegrationDetails | undefined {
    return this.integrationDetails.get(type);
  }

  /**
   * Get webhooks for an integration type
   */
  public getWebhooks(type: IntegrationType): Webhook[] {
    return this.webhooks.get(type) ?? [];
  }

  /**
   * Get all integrations
   */
  public getAllIntegrations(): Integration[] {
    return [...this.integrations];
  }

  /**
   * Get connected integrations
   */
  public getConnectedIntegrations(): Integration[] {
    return this.integrations.filter((i) => i.status === 'connected');
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this.stopPolling();
    this._onDidChangeTreeData.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.integrations = [];
    this.integrationDetails.clear();
    this.webhooks.clear();
  }
}

/**
 * Factory function to create and register the integrations tree provider
 */
export function createIntegrationsTreeProvider(
  context: vscode.ExtensionContext,
  options?: IntegrationsTreeProviderOptions
): IntegrationsTreeProvider {
  const provider = new IntegrationsTreeProvider(options);

  // Register the tree data provider
  const treeView = vscode.window.createTreeView('generacy.integrations', {
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
    vscode.commands.registerCommand('generacy.integrations.refresh', () => {
      provider.refresh();
    })
  );

  // Register view mode commands
  context.subscriptions.push(
    vscode.commands.registerCommand('generacy.integrations.viewFlat', () => {
      provider.setViewMode('flat');
    }),
    vscode.commands.registerCommand('generacy.integrations.viewByType', () => {
      provider.setViewMode('byType');
    })
  );

  // Add to disposables
  context.subscriptions.push(provider);
  context.subscriptions.push(treeView);

  return provider;
}
