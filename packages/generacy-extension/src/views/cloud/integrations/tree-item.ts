/**
 * Tree item classes for the Integrations Tree View.
 * Defines tree items for integration entries with status icons and grouping.
 */
import * as vscode from 'vscode';
import { Integration, IntegrationType, IntegrationStatus } from '../../../api/types';

/**
 * Status icon mapping for integrations
 */
const STATUS_ICONS: Record<IntegrationStatus, { icon: string; color?: string }> = {
  connected: { icon: 'check', color: 'charts.green' },
  disconnected: { icon: 'circle-slash', color: 'charts.gray' },
  error: { icon: 'error', color: 'charts.red' },
};

/**
 * Integration type icon mapping
 */
const TYPE_ICONS: Record<IntegrationType, string> = {
  github: 'github',
  gitlab: 'git-merge',
  bitbucket: 'git-branch',
  jira: 'issues',
  linear: 'checklist',
};

/**
 * Integration type display names
 */
const TYPE_LABELS: Record<IntegrationType, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  jira: 'Jira',
  linear: 'Linear',
};

/**
 * Tree item context value prefix
 */
const CONTEXT_PREFIX = 'integration';

/**
 * Tree item representing an integration entry
 */
export class IntegrationTreeItem extends vscode.TreeItem {
  public readonly integration: Integration;

  constructor(integration: Integration) {
    const hasChildren = integration.status === 'connected';
    super(
      TYPE_LABELS[integration.type] || integration.type,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.integration = integration;

    // Set context value for menus (e.g., 'integration-github-connected')
    this.contextValue = this.getContextValue();

    // Set icon based on status and type
    this.iconPath = this.getIcon();

    // Set description with account name and status
    this.description = this.getDescription();

    // Set tooltip with full details
    this.tooltip = this.getTooltip();

    // Set unique ID
    this.id = `integration-${integration.type}`;

    // Set command for disconnected integrations
    if (integration.status === 'disconnected') {
      this.command = {
        command: 'generacy.integrations.connect',
        title: 'Connect',
        arguments: [integration.type],
      };
    }
  }

  /**
   * Get context value based on integration type and status
   */
  private getContextValue(): string {
    const { type, status } = this.integration;
    return `${CONTEXT_PREFIX}-${type}-${status}`;
  }

  /**
   * Get the icon based on status
   */
  private getIcon(): vscode.ThemeIcon {
    const statusConfig = STATUS_ICONS[this.integration.status];
    const color = statusConfig.color ? new vscode.ThemeColor(statusConfig.color) : undefined;
    return new vscode.ThemeIcon(statusConfig.icon, color);
  }

  /**
   * Get the description text
   */
  private getDescription(): string {
    const { status, accountName } = this.integration;

    const parts: string[] = [];

    if (accountName) {
      parts.push(accountName);
    }

    // Add status indicator
    switch (status) {
      case 'connected':
        break; // Don't show 'connected', it's implied by the icon
      case 'disconnected':
        parts.push('Not connected');
        break;
      case 'error':
        parts.push('Connection error');
        break;
    }

    return parts.join(' • ');
  }

  /**
   * Get detailed tooltip
   */
  private getTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const { type, status, accountName, connectedAt, error } = this.integration;

    const typeLabel = TYPE_LABELS[type] || type;
    const typeIcon = TYPE_ICONS[type];

    md.appendMarkdown(`## $(${typeIcon}) ${typeLabel}\n\n`);

    // Status with icon
    const statusIcon = STATUS_ICONS[status].icon;
    md.appendMarkdown(`**Status:** $(${statusIcon}) ${this.capitalizeFirst(status)}\n\n`);

    // Account name
    if (accountName) {
      md.appendMarkdown(`**Account:** \`${accountName}\`\n\n`);
    }

    // Connected time
    if (connectedAt) {
      const date = new Date(connectedAt);
      md.appendMarkdown(`**Connected:** ${date.toLocaleString()}\n\n`);
    }

    // Error message
    if (error) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`**Error:**\n\`\`\`\n${error}\n\`\`\`\n`);
    }

    // Action hint
    if (status === 'disconnected') {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`*Click to connect*\n`);
    }

    return md;
  }

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

/**
 * Tree item for integration type category headers
 */
export class IntegrationTypeGroupItem extends vscode.TreeItem {
  public readonly integrationType: IntegrationType;
  public readonly integrations: Integration[];

  constructor(type: IntegrationType, integrations: Integration[]) {
    const label = TYPE_LABELS[type] || type;
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.integrationType = type;
    this.integrations = integrations;

    // Count connected vs total
    const connectedCount = integrations.filter((i) => i.status === 'connected').length;
    this.description = `(${connectedCount}/${integrations.length} connected)`;

    // Set icon based on type
    this.iconPath = new vscode.ThemeIcon(TYPE_ICONS[type]);

    // Set context value
    this.contextValue = `integrationGroup-${type}`;

    // Set unique ID
    this.id = `integration-group-${type}`;
  }
}

/**
 * Tree item for "No integrations" placeholder
 */
export class IntegrationEmptyItem extends vscode.TreeItem {
  constructor(message: string = 'No integrations configured') {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'integrationEmpty';
  }
}

/**
 * Tree item for loading state
 */
export class IntegrationLoadingItem extends vscode.TreeItem {
  constructor() {
    super('Loading integrations...', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'integrationLoading';
  }
}

/**
 * Tree item for error state
 */
export class IntegrationErrorItem extends vscode.TreeItem {
  public readonly error: Error;

  constructor(error: Error) {
    super('Failed to load integrations', vscode.TreeItemCollapsibleState.None);
    this.error = error;
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    this.contextValue = 'integrationError';
    this.tooltip = new vscode.MarkdownString(`**Error:** ${error.message}`);
    this.description = 'Click to retry';
    this.command = {
      command: 'generacy.integrations.refresh',
      title: 'Retry',
    };
  }
}

/**
 * Tree item for connected repository (child of GitHub integration)
 */
export class RepositoryTreeItem extends vscode.TreeItem {
  public readonly repositoryFullName: string;
  public readonly isPrivate: boolean;

  constructor(fullName: string, isPrivate: boolean) {
    super(fullName, vscode.TreeItemCollapsibleState.None);
    this.repositoryFullName = fullName;
    this.isPrivate = isPrivate;

    // Set icon
    this.iconPath = new vscode.ThemeIcon(isPrivate ? 'lock' : 'repo');

    // Set context value
    this.contextValue = 'integrationRepository';

    // Set unique ID
    this.id = `repo-${fullName}`;

    // Set tooltip
    this.tooltip = `${fullName}${isPrivate ? ' (Private)' : ' (Public)'}`;
  }
}

/**
 * Tree item for webhook entry
 */
export class WebhookTreeItem extends vscode.TreeItem {
  public readonly webhookId: string;
  public readonly webhookUrl: string;
  public readonly isActive: boolean;
  public readonly integrationType: IntegrationType;

  constructor(
    id: string,
    url: string,
    events: string[],
    active: boolean,
    integrationType: IntegrationType,
    lastStatus?: 'success' | 'failure'
  ) {
    // Show shortened URL as label
    const urlObj = new URL(url);
    const shortUrl = `${urlObj.hostname}${urlObj.pathname}`;
    super(shortUrl, vscode.TreeItemCollapsibleState.None);

    this.webhookId = id;
    this.webhookUrl = url;
    this.isActive = active;
    this.integrationType = integrationType;

    // Set icon based on status
    if (!active) {
      this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'));
    } else if (lastStatus === 'failure') {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
    } else {
      this.iconPath = new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.green'));
    }

    // Set description with event count
    this.description = `${events.length} event${events.length !== 1 ? 's' : ''}${!active ? ' (disabled)' : ''}`;

    // Set context value
    this.contextValue = active ? 'webhook-active' : 'webhook-inactive';

    // Set unique ID
    this.id = `webhook-${id}`;

    // Set tooltip
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**Webhook**\n\n`);
    md.appendMarkdown(`**URL:** \`${url}\`\n\n`);
    md.appendMarkdown(`**Events:** ${events.join(', ')}\n\n`);
    md.appendMarkdown(`**Status:** ${active ? 'Active' : 'Disabled'}\n`);
    if (lastStatus) {
      md.appendMarkdown(`**Last Delivery:** ${lastStatus === 'success' ? '✓ Success' : '✗ Failed'}\n`);
    }
    this.tooltip = md;
  }
}

/**
 * Tree item for webhook section header
 */
export class WebhookSectionItem extends vscode.TreeItem {
  public readonly integrationType: IntegrationType;

  constructor(type: IntegrationType, webhookCount: number) {
    super('Webhooks', vscode.TreeItemCollapsibleState.Collapsed);
    this.integrationType = type;

    this.iconPath = new vscode.ThemeIcon('link');
    this.description = `(${webhookCount})`;
    this.contextValue = 'webhookSection';
    this.id = `webhooks-${type}`;
  }
}

/**
 * Union type for all integration tree items
 */
export type IntegrationExplorerItem =
  | IntegrationTreeItem
  | IntegrationTypeGroupItem
  | IntegrationEmptyItem
  | IntegrationLoadingItem
  | IntegrationErrorItem
  | RepositoryTreeItem
  | WebhookTreeItem
  | WebhookSectionItem;

/**
 * Type guard for IntegrationTreeItem
 */
export function isIntegrationTreeItem(item: vscode.TreeItem): item is IntegrationTreeItem {
  return item.contextValue?.startsWith(CONTEXT_PREFIX + '-') ?? false;
}

/**
 * Type guard for IntegrationTypeGroupItem
 */
export function isIntegrationTypeGroupItem(item: vscode.TreeItem): item is IntegrationTypeGroupItem {
  return item.contextValue?.startsWith('integrationGroup') ?? false;
}

/**
 * Type guard for WebhookSectionItem
 */
export function isWebhookSectionItem(item: vscode.TreeItem): item is WebhookSectionItem {
  return item.contextValue === 'webhookSection';
}

/**
 * Type guard for WebhookTreeItem
 */
export function isWebhookTreeItem(item: vscode.TreeItem): item is WebhookTreeItem {
  return item.contextValue?.startsWith('webhook-') ?? false;
}

/**
 * Type guard for RepositoryTreeItem
 */
export function isRepositoryTreeItem(item: vscode.TreeItem): item is RepositoryTreeItem {
  return item.contextValue === 'integrationRepository';
}
