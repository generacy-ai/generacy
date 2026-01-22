/**
 * Execution history panel for workflow debugging.
 * Shows a timeline of execution events with the ability to inspect past states.
 */
import * as vscode from 'vscode';
import { getDebugExecutionState, type HistoryEntry, type WorkflowState } from '../../../debug';
import { getDebugSession } from './session';

/**
 * History entry with computed display info
 */
export interface DisplayHistoryEntry extends HistoryEntry {
  id: number;
  durationMs?: number;
  phaseDisplayName?: string;
  stepDisplayName?: string;
}

/**
 * History tree item types
 */
export type HistoryItemType = 'phase' | 'step' | 'variable' | 'output' | 'group';

/**
 * History tree item
 */
export class HistoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry: DisplayHistoryEntry | undefined,
    public readonly itemType: HistoryItemType,
    public readonly groupLabel?: string,
    public readonly children: HistoryTreeItem[] = []
  ) {
    super(
      groupLabel ?? HistoryTreeItem.getLabel(entry, itemType),
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );

    if (entry) {
      this.description = this.getDescription(entry);
      this.tooltip = this.createTooltip(entry);
      this.iconPath = this.getIcon(entry);
      this.contextValue = `historyEntry-${entry.type}-${entry.action}`;
    } else {
      this.contextValue = 'historyGroup';
      this.iconPath = new vscode.ThemeIcon('folder');
    }
  }

  private static getLabel(entry: DisplayHistoryEntry | undefined, _type: HistoryItemType): string {
    if (!entry) return 'Unknown';

    switch (entry.type) {
      case 'phase':
        return entry.phaseName ?? 'Unknown Phase';
      case 'step':
        return entry.stepName ?? 'Unknown Step';
      case 'variable':
        return `Set: ${entry.details?.split('=')[0]?.trim() ?? 'variable'}`;
      case 'output':
        return `Output: ${entry.details?.split('=')[0]?.trim() ?? 'output'}`;
      default:
        return 'Event';
    }
  }

  private getDescription(entry: DisplayHistoryEntry): string {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const action = this.formatAction(entry.action);

    if (entry.durationMs !== undefined) {
      return `${action} (${entry.durationMs}ms) at ${time}`;
    }
    return `${action} at ${time}`;
  }

  private formatAction(action: HistoryEntry['action']): string {
    switch (action) {
      case 'start':
        return '▶ Started';
      case 'complete':
        return '✓ Completed';
      case 'fail':
        return '✗ Failed';
      case 'skip':
        return '↷ Skipped';
      case 'set':
        return '= Set';
      default:
        return action;
    }
  }

  private createTooltip(entry: DisplayHistoryEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### ${entry.type.charAt(0).toUpperCase() + entry.type.slice(1)} Event\n\n`);
    md.appendMarkdown(`**Action:** ${entry.action}\n\n`);
    md.appendMarkdown(`**Time:** ${new Date(entry.timestamp).toLocaleString()}\n\n`);

    if (entry.phaseName) {
      md.appendMarkdown(`**Phase:** ${entry.phaseName}\n\n`);
    }
    if (entry.stepName) {
      md.appendMarkdown(`**Step:** ${entry.stepName}\n\n`);
    }
    if (entry.details) {
      md.appendMarkdown(`**Details:**\n\`\`\`\n${entry.details}\n\`\`\`\n`);
    }
    if (entry.durationMs !== undefined) {
      md.appendMarkdown(`**Duration:** ${entry.durationMs}ms\n`);
    }

    return md;
  }

  private getIcon(entry: DisplayHistoryEntry): vscode.ThemeIcon {
    const actionColors: Record<string, vscode.ThemeColor | undefined> = {
      start: new vscode.ThemeColor('charts.blue'),
      complete: new vscode.ThemeColor('charts.green'),
      fail: new vscode.ThemeColor('charts.red'),
      skip: new vscode.ThemeColor('charts.yellow'),
      set: undefined,
    };

    const typeIcons: Record<string, string> = {
      phase: 'symbol-class',
      step: 'symbol-method',
      variable: 'symbol-variable',
      output: 'output',
    };

    const iconName = typeIcons[entry.type] ?? 'circle-outline';
    const color = actionColors[entry.action];

    return new vscode.ThemeIcon(iconName, color);
  }
}

/**
 * Execution history tree view provider
 */
export class ExecutionHistoryProvider implements vscode.TreeDataProvider<HistoryTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<HistoryTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private stateSubscription: vscode.Disposable | undefined;
  private groupByPhase = true;
  private showVariables = true;
  private showOutputs = true;

  constructor() {
    const state = getDebugExecutionState();
    this.stateSubscription = state.onStateChange(() => {
      this.refresh();
    });
  }

  /**
   * Refresh the tree view
   */
  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  /**
   * Toggle grouping by phase
   */
  public toggleGroupByPhase(): void {
    this.groupByPhase = !this.groupByPhase;
    this.refresh();
  }

  /**
   * Toggle showing variables
   */
  public toggleShowVariables(): void {
    this.showVariables = !this.showVariables;
    this.refresh();
  }

  /**
   * Toggle showing outputs
   */
  public toggleShowOutputs(): void {
    this.showOutputs = !this.showOutputs;
    this.refresh();
  }

  public getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: HistoryTreeItem): HistoryTreeItem[] {
    if (element) {
      return element.children;
    }

    const state = getDebugExecutionState();
    const history = state.getHistory();

    if (history.length === 0) {
      return [];
    }

    // Convert to display entries
    const displayEntries = this.toDisplayEntries(history);

    // Filter based on settings
    const filtered = displayEntries.filter(entry => {
      if (entry.type === 'variable' && !this.showVariables) return false;
      if (entry.type === 'output' && !this.showOutputs) return false;
      return true;
    });

    if (this.groupByPhase) {
      return this.groupEntriesByPhase(filtered);
    }

    return filtered.map(entry => new HistoryTreeItem(entry, entry.type));
  }

  /**
   * Convert raw history entries to display entries with additional info
   */
  private toDisplayEntries(history: HistoryEntry[]): DisplayHistoryEntry[] {
    const entries: DisplayHistoryEntry[] = [];
    const startTimes: Map<string, number> = new Map();

    for (let i = 0; i < history.length; i++) {
      const entry = history[i];
      if (!entry) continue;

      const displayEntry: DisplayHistoryEntry = {
        ...entry,
        id: i,
      };

      // Calculate duration for step/phase completions
      if (entry.action === 'start') {
        const key = `${entry.type}:${entry.phaseName}:${entry.stepName}`;
        startTimes.set(key, entry.timestamp);
      } else if (entry.action === 'complete' || entry.action === 'fail') {
        const key = `${entry.type}:${entry.phaseName}:${entry.stepName}`;
        const startTime = startTimes.get(key);
        if (startTime) {
          displayEntry.durationMs = entry.timestamp - startTime;
        }
      }

      entries.push(displayEntry);
    }

    return entries;
  }

  /**
   * Group entries by phase
   */
  private groupEntriesByPhase(entries: DisplayHistoryEntry[]): HistoryTreeItem[] {
    const groups: Map<string, DisplayHistoryEntry[]> = new Map();
    const groupOrder: string[] = [];

    for (const entry of entries) {
      const phaseName = entry.phaseName ?? 'Workflow';

      if (!groups.has(phaseName)) {
        groups.set(phaseName, []);
        groupOrder.push(phaseName);
      }

      groups.get(phaseName)!.push(entry);
    }

    return groupOrder.map(phaseName => {
      const phaseEntries = groups.get(phaseName) ?? [];
      const children = phaseEntries.map(e => new HistoryTreeItem(e, e.type));

      return new HistoryTreeItem(
        undefined,
        'group',
        `📁 ${phaseName} (${phaseEntries.length} events)`,
        children
      );
    });
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    this.stateSubscription?.dispose();
  }
}

/**
 * Register the execution history panel
 */
export function registerHistoryPanel(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const provider = new ExecutionHistoryProvider();
  disposables.push(provider);

  // Register tree view
  const treeView = vscode.window.createTreeView('generacy.debugHistory', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  disposables.push(treeView);

  // Register commands
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.refreshHistory', () => {
      provider.refresh();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.toggleGroupByPhase', () => {
      provider.toggleGroupByPhase();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.toggleShowVariables', () => {
      provider.toggleShowVariables();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.toggleShowOutputs', () => {
      provider.toggleShowOutputs();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.clearHistory', () => {
      const state = getDebugExecutionState();
      state.reset();
      provider.refresh();
    })
  );

  // Command to copy history entry details
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.copyHistoryEntry', (item: HistoryTreeItem) => {
      if (item.entry) {
        const text = JSON.stringify(item.entry, null, 2);
        vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('History entry copied to clipboard');
      }
    })
  );

  // Command to jump to step from history
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.jumpToHistoryEntry', (item: HistoryTreeItem) => {
      if (item.entry && (item.entry.type === 'step' || item.entry.type === 'phase')) {
        vscode.window.showInformationMessage(
          `Jump to ${item.entry.phaseName}:${item.entry.stepName ?? 'start'} - Use "Replay From Step" command.`
        );
      }
    })
  );

  return disposables;
}

/**
 * Get execution statistics from history
 */
export function getExecutionStatistics(): {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  totalDuration: number;
  averageStepDuration: number;
} {
  const state = getDebugExecutionState();
  const history = state.getHistory();

  let totalSteps = 0;
  let completedSteps = 0;
  let failedSteps = 0;
  let skippedSteps = 0;
  let totalDuration = 0;
  const stepDurations: number[] = [];

  const startTimes: Map<string, number> = new Map();

  for (const entry of history) {
    if (entry.type !== 'step') continue;

    const key = `${entry.phaseName}:${entry.stepName}`;

    switch (entry.action) {
      case 'start':
        totalSteps++;
        startTimes.set(key, entry.timestamp);
        break;
      case 'complete': {
        completedSteps++;
        const startTime = startTimes.get(key);
        if (startTime) {
          const duration = entry.timestamp - startTime;
          totalDuration += duration;
          stepDurations.push(duration);
        }
        break;
      }
      case 'fail': {
        failedSteps++;
        const failStartTime = startTimes.get(key);
        if (failStartTime) {
          const duration = entry.timestamp - failStartTime;
          totalDuration += duration;
          stepDurations.push(duration);
        }
        break;
      }
      case 'skip':
        skippedSteps++;
        break;
    }
  }

  const averageStepDuration = stepDurations.length > 0
    ? stepDurations.reduce((a, b) => a + b, 0) / stepDurations.length
    : 0;

  return {
    totalSteps,
    completedSteps,
    failedSteps,
    skippedSteps,
    totalDuration,
    averageStepDuration,
  };
}
