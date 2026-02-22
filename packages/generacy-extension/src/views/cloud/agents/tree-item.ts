/**
 * Tree item classes for the Agent Tree View.
 * Defines tree items for agent entries with status icons and grouping.
 */
import * as vscode from 'vscode';
import { Agent, AgentConnectionStatus, AgentDisplayStatus } from '../../../api/types';
import { TREE_ITEM_CONTEXT, CLOUD_COMMANDS } from '../../../constants';

/**
 * Map raw connection status to display status
 */
export function getDisplayStatus(status: AgentConnectionStatus): AgentDisplayStatus {
  switch (status) {
    case 'connected':
    case 'idle':
      return 'available';
    case 'busy':
      return 'busy';
    case 'disconnected':
      return 'offline';
  }
}

/**
 * Status icon mapping for agent display status
 */
const STATUS_ICONS: Record<AgentDisplayStatus, { icon: string; color: string }> = {
  available: { icon: 'check', color: 'charts.green' },
  busy: { icon: 'sync~spin', color: 'charts.blue' },
  offline: { icon: 'circle-slash', color: 'charts.gray' },
};

/**
 * Tree item representing an individual agent
 */
export class AgentTreeItem extends vscode.TreeItem {
  public readonly agent: Agent;

  constructor(agent: Agent) {
    super(agent.name, vscode.TreeItemCollapsibleState.None);
    this.agent = agent;

    const displayStatus = getDisplayStatus(agent.status);

    this.contextValue = `${TREE_ITEM_CONTEXT.agent}-${displayStatus}`;
    this.iconPath = this.getStatusIcon(displayStatus);
    this.description = this.getDescription(displayStatus);
    this.tooltip = this.getTooltip(displayStatus);
    this.id = agent.id;
  }

  private getStatusIcon(displayStatus: AgentDisplayStatus): vscode.ThemeIcon {
    const config = STATUS_ICONS[displayStatus];
    return new vscode.ThemeIcon(config.icon, new vscode.ThemeColor(config.color));
  }

  private getDescription(displayStatus: AgentDisplayStatus): string {
    const parts: string[] = [this.agent.type];

    if (displayStatus === 'busy' && this.agent.metadata.workflowId) {
      parts.push(this.agent.metadata.workflowId);
    }

    return parts.join(' • ');
  }

  private getTooltip(displayStatus: AgentDisplayStatus): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const { name, type, status, capabilities, lastSeen, metadata } = this.agent;

    md.appendMarkdown(`## ${name}\n\n`);

    const statusConfig = STATUS_ICONS[displayStatus];
    md.appendMarkdown(
      `**Status:** $(${statusConfig.icon}) ${displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)} (${status})\n\n`
    );

    md.appendMarkdown(`**Type:** ${type}\n\n`);

    if (capabilities.length > 0) {
      md.appendMarkdown(`**Capabilities:** ${capabilities.join(', ')}\n\n`);
    }

    if (metadata.workflowId) {
      md.appendMarkdown(`**Current Assignment:** \`${metadata.workflowId}\`\n\n`);
    }

    md.appendMarkdown(`---\n\n`);

    if (metadata.version) {
      md.appendMarkdown(`**Version:** ${metadata.version}\n\n`);
    }

    if (metadata.platform) {
      md.appendMarkdown(`**Platform:** ${metadata.platform}\n\n`);
    }

    md.appendMarkdown(`**Last Seen:** ${new Date(lastSeen).toLocaleString()}\n`);

    return md;
  }
}

/**
 * Tree item for agent status group headers (e.g., "Available (3)")
 */
export class AgentGroupItem extends vscode.TreeItem {
  public readonly status: AgentDisplayStatus;

  constructor(status: AgentDisplayStatus, count: number) {
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    const collapsibleState =
      status === 'offline'
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded;

    super(label, collapsibleState);
    this.status = status;

    this.description = `(${count})`;
    this.contextValue = TREE_ITEM_CONTEXT.agentGroup;
    this.id = `agent-group-${status}`;

    const config = STATUS_ICONS[status];
    this.iconPath = new vscode.ThemeIcon(config.icon, new vscode.ThemeColor(config.color));
  }
}

/**
 * Tree item for empty state
 */
export class AgentEmptyItem extends vscode.TreeItem {
  constructor() {
    super('No agents connected', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'agentEmpty';
    this.description = 'Configure agents to get started';
  }
}

/**
 * Tree item for loading state
 */
export class AgentLoadingItem extends vscode.TreeItem {
  constructor() {
    super('Loading agents...', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'agentLoading';
  }
}

/**
 * Tree item for error state
 */
export class AgentErrorItem extends vscode.TreeItem {
  public readonly error: Error;

  constructor(error: Error) {
    super('Failed to load agents', vscode.TreeItemCollapsibleState.None);
    this.error = error;
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    this.contextValue = 'agentError';
    this.tooltip = new vscode.MarkdownString(`**Error:** ${error.message}`);
    this.description = 'Click to retry';
    this.command = {
      command: CLOUD_COMMANDS.refreshAgents,
      title: 'Retry',
    };
  }
}

/**
 * Union type for all agent tree items
 */
export type AgentExplorerItem =
  | AgentTreeItem
  | AgentGroupItem
  | AgentEmptyItem
  | AgentLoadingItem
  | AgentErrorItem;

/**
 * Type guard for AgentTreeItem
 */
export function isAgentTreeItem(item: vscode.TreeItem): item is AgentTreeItem {
  return item.contextValue?.startsWith(TREE_ITEM_CONTEXT.agent + '-') ?? false;
}
