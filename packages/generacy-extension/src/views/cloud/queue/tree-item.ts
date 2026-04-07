/**
 * Tree item classes for the Queue Tree View.
 * Defines tree items for queue entries with status icons and filtering.
 */
import * as vscode from 'vscode';
import { QueueItem, QueueItemProgressSummary, QueueStatus, QueuePriority } from '../../../api/types';
import type { OrgCapacity } from '../../../api/endpoints/orgs';
import { TREE_ITEM_CONTEXT } from '../../../constants';

/**
 * Status icon mapping for queue items
 */
const STATUS_ICONS: Record<QueueStatus, { icon: string; color?: string }> = {
  pending: { icon: 'clock', color: 'charts.yellow' },
  running: { icon: 'sync~spin', color: 'charts.blue' },
  waiting: { icon: 'bell', color: 'charts.orange' },
  completed: { icon: 'check', color: 'charts.green' },
  failed: { icon: 'error', color: 'charts.red' },
  cancelled: { icon: 'circle-slash', color: 'charts.gray' },
};

/**
 * Priority icon mapping
 */
const PRIORITY_ICONS: Record<QueuePriority, string> = {
  low: 'arrow-down',
  normal: 'dash',
  high: 'arrow-up',
  urgent: 'flame',
};

/**
 * Tree item representing a queue entry
 */
export class QueueTreeItem extends vscode.TreeItem {
  public readonly queueItem: QueueItem;
  private readonly progress: QueueItemProgressSummary | undefined;
  private readonly capacity: OrgCapacity | undefined;
  /** Whether this item is pending because org execution slots are full */
  public readonly isSlotWaiting: boolean;

  constructor(item: QueueItem, progress?: QueueItemProgressSummary, capacity?: OrgCapacity) {
    super(item.workflowName, vscode.TreeItemCollapsibleState.None);
    this.queueItem = item;
    this.progress = progress;
    this.capacity = capacity;
    this.isSlotWaiting = item.status === 'pending' && !!capacity?.isAtCapacity;

    // Set context value for menus
    this.contextValue = this.getContextValue();

    // Set icon based on status
    this.iconPath = this.getStatusIcon();

    // Set description with status and time info
    this.description = this.getDescription();

    // Set tooltip with full details
    this.tooltip = this.getTooltip();

    // Set unique ID
    this.id = item.id;
  }

  /**
   * Get context value based on item status
   * This enables context-specific menu items
   */
  private getContextValue(): string {
    const status = this.queueItem.status;
    // Include status in context for conditional menu items
    // e.g., 'queueItem-pending', 'queueItem-running', etc.
    return `${TREE_ITEM_CONTEXT.queueItem}-${status}`;
  }

  /**
   * Get the status icon with color.
   * Slot-waiting items use a distinct `watch` icon with amber color.
   */
  private getStatusIcon(): vscode.ThemeIcon {
    if (this.isSlotWaiting) {
      return new vscode.ThemeIcon('watch', new vscode.ThemeColor('charts.orange'));
    }
    const statusConfig = STATUS_ICONS[this.queueItem.status];
    const color = statusConfig.color
      ? new vscode.ThemeColor(statusConfig.color)
      : undefined;
    return new vscode.ThemeIcon(statusConfig.icon, color);
  }

  /**
   * Get the description text (shown next to label)
   * Format with progress: `repository • Phase 5/8 · implementation • running for 18m`
   * Format with skipped: `repository • Phase 5/8 (2 skipped) · implementation • running for 18m`
   * Format without progress: `repository • running for 18m`
   */
  private getDescription(): string {
    const parts: string[] = [];

    // Add repository if present
    if (this.queueItem.repository) {
      parts.push(this.queueItem.repository);
    }

    // Add slot-waiting indicator
    if (this.isSlotWaiting) {
      parts.push('waiting for slot');
    }

    // Add waitingFor label for waiting items
    if (this.queueItem.status === 'waiting' && this.queueItem.waitingFor) {
      parts.push(this.queueItem.waitingFor);
    }

    // Add progress info for running jobs
    const progressInfo = this.getProgressInfo();
    if (progressInfo) {
      parts.push(progressInfo);
    }

    // Add time info based on status
    const timeInfo = this.getTimeInfo();
    if (timeInfo) {
      parts.push(timeInfo);
    }

    return parts.join(' • ');
  }

  /**
   * Get progress info string from QueueItemProgressSummary.
   * Returns e.g. "Phase 5/8 · implementation" or "Phase 5/8 (2 skipped) · implementation"
   */
  private getProgressInfo(): string | undefined {
    if (!this.progress || this.queueItem.status !== 'running') {
      return undefined;
    }

    const { phaseProgress, skippedPhases, currentPhase } = this.progress;
    if (!phaseProgress) {
      return undefined;
    }

    let info = phaseProgress;

    if (skippedPhases && skippedPhases > 0) {
      info += ` (${skippedPhases} skipped)`;
    }

    if (currentPhase) {
      info += ` · ${currentPhase}`;
    }

    return info;
  }

  /**
   * Get human-readable time info based on status
   */
  private getTimeInfo(): string | undefined {
    const { status, queuedAt, startedAt, completedAt } = this.queueItem;

    const formatDuration = (start: string, end?: string): string => {
      const startDate = new Date(start);
      const endDate = end ? new Date(end) : new Date();
      const diffMs = endDate.getTime() - startDate.getTime();
      const diffSec = Math.floor(diffMs / 1000);

      if (diffSec < 60) {
        return `${diffSec}s`;
      }
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        return `${diffMin}m`;
      }
      const diffHour = Math.floor(diffMin / 60);
      return `${diffHour}h ${diffMin % 60}m`;
    };

    const formatRelativeTime = (dateStr: string): string => {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffSec = Math.floor(diffMs / 1000);

      if (diffSec < 60) {
        return 'just now';
      }
      const diffMin = Math.floor(diffSec / 60);
      if (diffMin < 60) {
        return `${diffMin}m ago`;
      }
      const diffHour = Math.floor(diffMin / 60);
      if (diffHour < 24) {
        return `${diffHour}h ago`;
      }
      const diffDay = Math.floor(diffHour / 24);
      return `${diffDay}d ago`;
    };

    switch (status) {
      case 'pending':
        return `queued ${formatRelativeTime(queuedAt)}`;
      case 'running':
        return startedAt ? `running for ${formatDuration(startedAt)}` : 'starting...';
      case 'completed':
        if (startedAt && completedAt) {
          return `completed in ${formatDuration(startedAt, completedAt)}`;
        }
        return completedAt ? formatRelativeTime(completedAt) : undefined;
      case 'failed':
        return completedAt ? `failed ${formatRelativeTime(completedAt)}` : 'failed';
      case 'waiting':
        return startedAt ? `waiting for ${formatDuration(startedAt)}` : 'waiting';
      case 'cancelled':
        return completedAt ? `cancelled ${formatRelativeTime(completedAt)}` : 'cancelled';
      default:
        return undefined;
    }
  }

  /**
   * Get detailed tooltip
   */
  private getTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const { workflowName, workflowId, status, priority, repository, queuedAt, startedAt, completedAt, error } =
      this.queueItem;

    md.appendMarkdown(`## ${workflowName}\n\n`);

    // Status with icon
    const statusIcon = STATUS_ICONS[status].icon;
    md.appendMarkdown(`**Status:** $(${statusIcon}) ${this.capitalizeFirst(status)}\n\n`);

    // Priority
    const priorityIcon = PRIORITY_ICONS[priority];
    md.appendMarkdown(`**Priority:** $(${priorityIcon}) ${this.capitalizeFirst(priority)}\n\n`);

    // Slot-waiting capacity info
    if (this.isSlotWaiting && this.capacity) {
      md.appendMarkdown(`**Execution Slots:** ${this.capacity.activeExecutions}/${this.capacity.maxConcurrentAgents} in use\n\n`);
    }

    // Waiting for info
    if (this.queueItem.waitingFor) {
      md.appendMarkdown(`**Waiting for:** ${this.queueItem.waitingFor}\n\n`);
    }

    // Repository
    if (repository) {
      md.appendMarkdown(`**Repository:** \`${repository}\`\n\n`);
    }

    // Workflow ID
    md.appendMarkdown(`**Workflow ID:** \`${workflowId}\`\n\n`);

    // Progress summary
    if (this.progress && this.progress.phaseProgress) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`### Progress\n\n`);
      md.appendMarkdown(`**Phase:** ${this.progress.phaseProgress}`);
      if (this.progress.skippedPhases && this.progress.skippedPhases > 0) {
        md.appendMarkdown(` (${this.progress.skippedPhases} skipped)`);
      }
      md.appendMarkdown(`\n\n`);
      if (this.progress.currentPhase) {
        md.appendMarkdown(`**Current Phase:** ${this.progress.currentPhase}\n\n`);
      }
    }

    // Timestamps
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`**Queued:** ${this.formatDateTime(queuedAt)}\n\n`);

    if (startedAt) {
      md.appendMarkdown(`**Started:** ${this.formatDateTime(startedAt)}\n\n`);
    }

    if (completedAt) {
      md.appendMarkdown(`**Completed:** ${this.formatDateTime(completedAt)}\n\n`);
    }

    // Error message if failed
    if (error) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`**Error:**\n\`\`\`\n${error}\n\`\`\`\n`);
    }

    return md;
  }

  /**
   * Format a date/time string
   */
  private formatDateTime(dateStr: string): string {
    const date = new Date(dateStr);
    return date.toLocaleString();
  }

  /**
   * Capitalize first letter
   */
  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

/**
 * Tree item for filter category headers
 */
export class QueueFilterGroupItem extends vscode.TreeItem {
  public readonly filterType: 'status' | 'repository' | 'assignee';
  public readonly filterValue: string;

  constructor(
    label: string,
    filterType: 'status' | 'repository' | 'assignee',
    filterValue: string,
    itemCount: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Collapsed);
    this.filterType = filterType;
    this.filterValue = filterValue;

    // Set description with count
    this.description = `(${itemCount})`;

    // Set icon based on filter type
    this.iconPath = this.getFilterIcon();

    // Set context value
    this.contextValue = `queueFilter-${filterType}`;

    // Set unique ID
    this.id = `filter-${filterType}-${filterValue}`;
  }

  private getFilterIcon(): vscode.ThemeIcon {
    switch (this.filterType) {
      case 'status': {
        const statusConfig = STATUS_ICONS[this.filterValue as QueueStatus];
        if (statusConfig) {
          const color = statusConfig.color
            ? new vscode.ThemeColor(statusConfig.color)
            : undefined;
          return new vscode.ThemeIcon(statusConfig.icon, color);
        }
        return new vscode.ThemeIcon('filter');
      }
      case 'repository':
        return new vscode.ThemeIcon('repo');
      case 'assignee':
        return new vscode.ThemeIcon('person');
      default:
        return new vscode.ThemeIcon('filter');
    }
  }
}

/**
 * Tree item for "No items" placeholder
 */
export class QueueEmptyItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'queueEmpty';
  }
}

/**
 * Tree item for loading state
 */
export class QueueLoadingItem extends vscode.TreeItem {
  constructor() {
    super('Loading queue...', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('sync~spin');
    this.contextValue = 'queueLoading';
  }
}

/**
 * Tree item for error state
 */
export class QueueErrorItem extends vscode.TreeItem {
  public readonly error: Error;

  constructor(error: Error) {
    super('Failed to load queue', vscode.TreeItemCollapsibleState.None);
    this.error = error;
    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    this.contextValue = 'queueError';
    this.tooltip = new vscode.MarkdownString(`**Error:** ${error.message}`);
    this.description = 'Click to retry';
    this.command = {
      command: 'generacy.queue.refresh',
      title: 'Retry',
    };
  }
}

/**
 * Union type for all queue tree items
 */
export type QueueExplorerItem =
  | QueueTreeItem
  | QueueFilterGroupItem
  | QueueEmptyItem
  | QueueLoadingItem
  | QueueErrorItem;

/**
 * Type guard for QueueTreeItem
 */
export function isQueueTreeItem(item: vscode.TreeItem): item is QueueTreeItem {
  return item.contextValue?.startsWith(TREE_ITEM_CONTEXT.queueItem) ?? false;
}

/**
 * Type guard for QueueFilterGroupItem
 */
export function isQueueFilterGroupItem(item: vscode.TreeItem): item is QueueFilterGroupItem {
  return item.contextValue?.startsWith('queueFilter') ?? false;
}
