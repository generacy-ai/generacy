/**
 * Variables view provider for workflow debugging.
 * Shows current execution state including local, phase, workflow, and environment variables.
 */
import * as vscode from 'vscode';
import { getDebugSession, type DebugContext } from './session';
import { getDebugExecutionState, type DebugVariable, type DebugScope } from '../../../debug';

/**
 * Variable categories for the tree view
 */
export type VariableCategory = 'local' | 'phase' | 'workflow' | 'environment' | 'outputs';

/**
 * Tree item for variable display
 */
export class VariableTreeItem extends vscode.TreeItem {
  constructor(
    public readonly name: string,
    public readonly value: string,
    public readonly type: string,
    public readonly variablesReference: number,
    public readonly category: VariableCategory,
    public readonly path: string[]
  ) {
    super(
      name,
      variablesReference > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );

    this.description = this.formatValue(value);
    this.tooltip = this.createTooltip();
    this.contextValue = 'variable';
    this.iconPath = this.getIconForType(type);
  }

  /**
   * Format value for display
   */
  private formatValue(value: string): string {
    if (value.length > 50) {
      return value.substring(0, 47) + '...';
    }
    return value;
  }

  /**
   * Create tooltip with full value
   */
  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.name}** \`${this.type}\`\n\n`);
    md.appendCodeblock(this.value, 'json');
    return md;
  }

  /**
   * Get icon based on type
   */
  private getIconForType(type: string): vscode.ThemeIcon {
    switch (type) {
      case 'string':
        return new vscode.ThemeIcon('symbol-string');
      case 'number':
        return new vscode.ThemeIcon('symbol-number');
      case 'boolean':
        return new vscode.ThemeIcon('symbol-boolean');
      case 'array':
        return new vscode.ThemeIcon('symbol-array');
      case 'object':
        return new vscode.ThemeIcon('symbol-object');
      case 'null':
      case 'undefined':
        return new vscode.ThemeIcon('symbol-null');
      default:
        return new vscode.ThemeIcon('symbol-variable');
    }
  }
}

/**
 * Scope tree item
 */
export class ScopeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly scope: DebugScope,
    public readonly category: VariableCategory
  ) {
    super(scope.name, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'scope';
    this.iconPath = this.getIconForScope(category);
    this.description = this.getScopeDescription(category);
  }

  private getIconForScope(category: VariableCategory): vscode.ThemeIcon {
    switch (category) {
      case 'local':
        return new vscode.ThemeIcon('symbol-variable');
      case 'phase':
        return new vscode.ThemeIcon('symbol-method');
      case 'workflow':
        return new vscode.ThemeIcon('symbol-class');
      case 'environment':
        return new vscode.ThemeIcon('symbol-constant');
      case 'outputs':
        return new vscode.ThemeIcon('output');
      default:
        return new vscode.ThemeIcon('symbol-namespace');
    }
  }

  private getScopeDescription(category: VariableCategory): string {
    switch (category) {
      case 'local':
        return 'Current step variables';
      case 'phase':
        return 'Current phase variables';
      case 'workflow':
        return 'Workflow-level variables';
      case 'environment':
        return 'Environment variables';
      case 'outputs':
        return 'Step outputs';
      default:
        return '';
    }
  }
}

/**
 * Variables view provider
 */
export class VariablesViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private stateSubscription: vscode.Disposable | undefined;
  private sessionSubscription: vscode.Disposable | undefined;

  constructor() {
    // Subscribe to state changes
    const state = getDebugExecutionState();
    this.stateSubscription = state.onStateChange(() => {
      this.refresh();
    });

    // Subscribe to session events
    const session = getDebugSession();
    this.sessionSubscription = session.addEventListener((event) => {
      if (event.type === 'stopped' || event.type === 'continued' || event.type === 'started') {
        this.refresh();
      }
    });
  }

  /**
   * Refresh the tree view
   */
  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  /**
   * Get tree item for element
   */
  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get children for element
   */
  public getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
    if (!element) {
      // Root level - return scopes
      return this.getScopes();
    }

    if (element instanceof ScopeTreeItem) {
      // Return variables in this scope
      return this.getVariablesForScope(element.category);
    }

    if (element instanceof VariableTreeItem && element.variablesReference > 0) {
      // Return child variables
      return this.getChildVariables(element.variablesReference);
    }

    return [];
  }

  /**
   * Get all scopes
   */
  private getScopes(): ScopeTreeItem[] {
    const session = getDebugSession();
    if (!session.isActive()) {
      return [];
    }

    const state = getDebugExecutionState();
    const scopes = state.getScopes(1); // frameId = 1

    const categoryMap: Record<string, VariableCategory> = {
      'Local': 'local',
      'Phase': 'phase',
      'Workflow': 'workflow',
      'Environment': 'environment',
      'Outputs': 'outputs',
    };

    return scopes.map(scope =>
      new ScopeTreeItem(scope, categoryMap[scope.name] ?? 'workflow')
    );
  }

  /**
   * Get variables for a scope
   */
  private getVariablesForScope(category: VariableCategory): VariableTreeItem[] {
    const session = getDebugSession();
    const context = session.getContext();

    if (!context) {
      return [];
    }

    let vars: Record<string, unknown>;

    switch (category) {
      case 'local':
      case 'phase':
      case 'workflow':
        vars = context.variables ?? {};
        break;
      case 'environment':
        vars = context.env ?? {};
        break;
      case 'outputs':
        vars = context.outputs ?? {};
        break;
      default:
        vars = {};
    }

    return this.convertToTreeItems(vars, category, []);
  }

  /**
   * Get child variables for a nested object
   */
  private getChildVariables(variablesReference: number): VariableTreeItem[] {
    const state = getDebugExecutionState();
    const variables = state.getVariables(variablesReference);

    return variables.map(v =>
      new VariableTreeItem(
        v.name,
        v.value,
        v.type ?? 'unknown',
        v.variablesReference,
        'workflow',
        [v.name]
      )
    );
  }

  /**
   * Convert a record to tree items
   */
  private convertToTreeItems(
    vars: Record<string, unknown>,
    category: VariableCategory,
    path: string[]
  ): VariableTreeItem[] {
    return Object.entries(vars).map(([name, value]) => {
      const type = this.getValueType(value);
      const formattedValue = this.formatValue(value);
      const hasChildren = typeof value === 'object' && value !== null;

      return new VariableTreeItem(
        name,
        formattedValue,
        type,
        hasChildren ? this.createTemporaryReference() : 0,
        category,
        [...path, name]
      );
    });
  }

  /**
   * Get the type of a value
   */
  private getValueType(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  /**
   * Format a value for display
   */
  private formatValue(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  private temporaryReferenceCounter = 10000;
  private createTemporaryReference(): number {
    return this.temporaryReferenceCounter++;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
    this.stateSubscription?.dispose();
    this.sessionSubscription?.dispose();
  }
}

/**
 * Register the variables view
 */
export function registerVariablesView(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const provider = new VariablesViewProvider();
  disposables.push(provider);

  const treeView = vscode.window.createTreeView('generacy.debugVariables', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  disposables.push(treeView);

  // Register refresh command
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.refreshVariables', () => {
      provider.refresh();
    })
  );

  return disposables;
}
