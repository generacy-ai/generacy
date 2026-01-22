/**
 * Watch expressions support for workflow debugging.
 * Allows users to add expressions to watch during debugging.
 */
import * as vscode from 'vscode';
import { getDebugSession } from './session';
import { getDebugExecutionState } from '../../../debug';

/**
 * Watch expression
 */
export interface WatchExpression {
  id: number;
  expression: string;
  value?: string;
  type?: string;
  error?: string;
}

/**
 * Watch expressions manager
 */
export class WatchExpressionsManager {
  private static instance: WatchExpressionsManager | undefined;
  private expressions: Map<number, WatchExpression> = new Map();
  private nextId = 1;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  private constructor() {
    // Subscribe to state changes to re-evaluate expressions
    const state = getDebugExecutionState();
    state.onStateChange(() => {
      this.evaluateAll();
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WatchExpressionsManager {
    if (!WatchExpressionsManager.instance) {
      WatchExpressionsManager.instance = new WatchExpressionsManager();
    }
    return WatchExpressionsManager.instance;
  }

  /**
   * Add a watch expression
   */
  public add(expression: string): WatchExpression {
    const id = this.nextId++;
    const watchExpr: WatchExpression = {
      id,
      expression,
    };

    this.expressions.set(id, watchExpr);
    this.evaluate(watchExpr);
    this.onDidChangeEmitter.fire();

    return watchExpr;
  }

  /**
   * Remove a watch expression
   */
  public remove(id: number): boolean {
    const result = this.expressions.delete(id);
    if (result) {
      this.onDidChangeEmitter.fire();
    }
    return result;
  }

  /**
   * Get all watch expressions
   */
  public getAll(): WatchExpression[] {
    return Array.from(this.expressions.values());
  }

  /**
   * Get a watch expression by ID
   */
  public get(id: number): WatchExpression | undefined {
    return this.expressions.get(id);
  }

  /**
   * Edit a watch expression
   */
  public edit(id: number, newExpression: string): boolean {
    const expr = this.expressions.get(id);
    if (!expr) {
      return false;
    }

    expr.expression = newExpression;
    expr.value = undefined;
    expr.error = undefined;
    this.evaluate(expr);
    this.onDidChangeEmitter.fire();

    return true;
  }

  /**
   * Clear all watch expressions
   */
  public clear(): void {
    this.expressions.clear();
    this.onDidChangeEmitter.fire();
  }

  /**
   * Evaluate a single expression
   */
  public evaluate(expr: WatchExpression): void {
    const session = getDebugSession();

    if (!session.isActive()) {
      expr.value = undefined;
      expr.error = 'No active debug session';
      return;
    }

    try {
      const result = this.evaluateExpression(expr.expression);
      expr.value = result.value;
      expr.type = result.type;
      expr.error = undefined;
    } catch (error) {
      expr.value = undefined;
      expr.error = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Evaluate all expressions
   */
  public evaluateAll(): void {
    for (const expr of this.expressions.values()) {
      this.evaluate(expr);
    }
    this.onDidChangeEmitter.fire();
  }

  /**
   * Evaluate an expression against current debug context
   */
  private evaluateExpression(expression: string): { value: string; type: string } {
    const session = getDebugSession();
    const context = session.getContext();

    if (!context) {
      throw new Error('No debug context available');
    }

    // Parse expression - support dot notation (e.g., "env.PATH", "outputs.step1.result")
    const parts = expression.split('.');

    let current: unknown;
    let type = 'unknown';

    // Determine starting scope
    const rootScope = parts[0];
    switch (rootScope) {
      case 'env':
        current = context.env;
        parts.shift();
        break;
      case 'variables':
        current = context.variables;
        parts.shift();
        break;
      case 'outputs':
        current = context.outputs;
        parts.shift();
        break;
      case 'phaseOutputs':
        current = context.phaseOutputs;
        parts.shift();
        break;
      default:
        // Try to find in all scopes
        current = this.findInAllScopes(expression, context);
        parts.length = 0; // Clear parts since we found the value directly
    }

    // Navigate nested properties
    for (const part of parts) {
      if (current === null || current === undefined) {
        throw new Error(`Cannot read property '${part}' of ${current}`);
      }

      if (typeof current !== 'object') {
        throw new Error(`Cannot read property '${part}' of ${typeof current}`);
      }

      current = (current as Record<string, unknown>)[part];
    }

    // Format the result
    if (current === null) {
      return { value: 'null', type: 'null' };
    }
    if (current === undefined) {
      return { value: 'undefined', type: 'undefined' };
    }
    if (Array.isArray(current)) {
      return { value: JSON.stringify(current), type: 'array' };
    }
    if (typeof current === 'object') {
      return { value: JSON.stringify(current, null, 2), type: 'object' };
    }

    type = typeof current;
    return { value: String(current), type };
  }

  /**
   * Find a variable in all scopes
   */
  private findInAllScopes(name: string, context: {
    env: Record<string, string>;
    variables: Record<string, unknown>;
    outputs: Record<string, unknown>;
    phaseOutputs: Record<string, unknown>;
  }): unknown {
    // Search order: local/phase outputs, workflow outputs, variables, environment
    if (name in context.phaseOutputs) {
      return context.phaseOutputs[name];
    }
    if (name in context.outputs) {
      return context.outputs[name];
    }
    if (name in context.variables) {
      return context.variables[name];
    }
    if (name in context.env) {
      return context.env[name];
    }

    throw new Error(`Variable '${name}' not found`);
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.expressions.clear();
    this.onDidChangeEmitter.dispose();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    WatchExpressionsManager.instance?.dispose();
    WatchExpressionsManager.instance = undefined;
  }
}

/**
 * Watch expression tree item
 */
export class WatchExpressionTreeItem extends vscode.TreeItem {
  constructor(public readonly watchExpr: WatchExpression) {
    super(
      watchExpr.expression,
      vscode.TreeItemCollapsibleState.None
    );

    if (watchExpr.error) {
      this.description = `⚠ ${watchExpr.error}`;
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
    } else if (watchExpr.value !== undefined) {
      this.description = this.formatValue(watchExpr.value);
      this.iconPath = this.getIconForType(watchExpr.type ?? 'unknown');
    } else {
      this.description = 'not available';
      this.iconPath = new vscode.ThemeIcon('question');
    }

    this.contextValue = 'watchExpression';
    this.tooltip = this.createTooltip();
  }

  private formatValue(value: string): string {
    if (value.length > 50) {
      return value.substring(0, 47) + '...';
    }
    return value;
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${this.watchExpr.expression}**\n\n`);

    if (this.watchExpr.error) {
      md.appendMarkdown(`⚠ Error: ${this.watchExpr.error}\n`);
    } else if (this.watchExpr.value !== undefined) {
      md.appendMarkdown(`Type: \`${this.watchExpr.type}\`\n\n`);
      md.appendCodeblock(this.watchExpr.value, 'json');
    }

    return md;
  }

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
      default:
        return new vscode.ThemeIcon('symbol-variable');
    }
  }
}

/**
 * Watch expressions tree view provider
 */
export class WatchExpressionsViewProvider implements vscode.TreeDataProvider<WatchExpressionTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<WatchExpressionTreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private readonly manager: WatchExpressionsManager;
  private subscription: vscode.Disposable;

  constructor() {
    this.manager = WatchExpressionsManager.getInstance();
    this.subscription = this.manager.onDidChange(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: WatchExpressionTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(_element?: WatchExpressionTreeItem): WatchExpressionTreeItem[] {
    const expressions = this.manager.getAll();
    return expressions.map(expr => new WatchExpressionTreeItem(expr));
  }

  public dispose(): void {
    this.subscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

/**
 * Register watch expressions view and commands
 */
export function registerWatchExpressions(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const manager = WatchExpressionsManager.getInstance();

  // Create tree view provider
  const provider = new WatchExpressionsViewProvider();
  disposables.push(provider);

  // Register tree view
  const treeView = vscode.window.createTreeView('generacy.debugWatch', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  disposables.push(treeView);

  // Register commands
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.addWatchExpression', async () => {
      const expression = await vscode.window.showInputBox({
        prompt: 'Enter expression to watch',
        placeHolder: 'e.g., env.PATH, outputs.step1, variables.myVar',
      });

      if (expression) {
        manager.add(expression);
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.editWatchExpression', async (item: WatchExpressionTreeItem) => {
      const expression = await vscode.window.showInputBox({
        prompt: 'Edit expression',
        value: item.watchExpr.expression,
      });

      if (expression !== undefined) {
        manager.edit(item.watchExpr.id, expression);
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.removeWatchExpression', (item: WatchExpressionTreeItem) => {
      manager.remove(item.watchExpr.id);
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.clearWatchExpressions', () => {
      manager.clear();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.refreshWatch', () => {
      manager.evaluateAll();
    })
  );

  return disposables;
}

/**
 * Get the watch expressions manager
 */
export function getWatchExpressionsManager(): WatchExpressionsManager {
  return WatchExpressionsManager.getInstance();
}
