/**
 * Error analysis with stack trace for workflow debugging.
 * Provides detailed error information, stack traces, and suggestions.
 */
import * as vscode from 'vscode';
import { getDebugExecutionState, type StepState, type PhaseState, type WorkflowState, type HistoryEntry } from '../../../debug';
import { getDebugSession } from './session';
import { getLogger } from '../../../utils';

/**
 * Error severity levels
 */
export type ErrorSeverity = 'error' | 'warning' | 'info';

/**
 * Error category for classification
 */
export type ErrorCategory =
  | 'execution'
  | 'validation'
  | 'timeout'
  | 'permission'
  | 'network'
  | 'configuration'
  | 'unknown';

/**
 * Stack trace frame
 */
export interface StackTraceFrame {
  /** Frame index (0 = most recent) */
  index: number;
  /** Frame name (step or phase name) */
  name: string;
  /** Phase name */
  phaseName: string;
  /** Step name (if applicable) */
  stepName?: string;
  /** Source file */
  source?: string;
  /** Line number in source */
  line?: number;
  /** Local variables at this frame */
  variables?: Record<string, unknown>;
}

/**
 * Analyzed error with context
 */
export interface AnalyzedError {
  /** Unique error ID */
  id: string;
  /** Error timestamp */
  timestamp: number;
  /** Error message */
  message: string;
  /** Error category */
  category: ErrorCategory;
  /** Error severity */
  severity: ErrorSeverity;
  /** Phase where error occurred */
  phaseName: string;
  /** Step where error occurred */
  stepName?: string;
  /** Exit code if available */
  exitCode?: number;
  /** Full stack trace */
  stackTrace: StackTraceFrame[];
  /** Raw error output */
  rawOutput?: string;
  /** Suggested fixes */
  suggestions: string[];
  /** Related errors */
  relatedErrors?: string[];
}

/**
 * Error analysis manager
 */
export class ErrorAnalysisManager {
  private static instance: ErrorAnalysisManager | undefined;
  private errors: Map<string, AnalyzedError> = new Map();
  private readonly onErrorAddedEmitter = new vscode.EventEmitter<AnalyzedError>();
  public readonly onErrorAdded = this.onErrorAddedEmitter.event;
  private errorIdCounter = 0;

  private constructor() {
    // Subscribe to state changes to detect errors
    const state = getDebugExecutionState();
    state.onStateChange((workflowState) => {
      if (workflowState) {
        this.checkForNewErrors(workflowState);
      }
    });
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ErrorAnalysisManager {
    if (!ErrorAnalysisManager.instance) {
      ErrorAnalysisManager.instance = new ErrorAnalysisManager();
    }
    return ErrorAnalysisManager.instance;
  }

  /**
   * Get all analyzed errors
   */
  public getAllErrors(): AnalyzedError[] {
    return Array.from(this.errors.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get error by ID
   */
  public getError(id: string): AnalyzedError | undefined {
    return this.errors.get(id);
  }

  /**
   * Get latest error
   */
  public getLatestError(): AnalyzedError | undefined {
    const errors = this.getAllErrors();
    return errors[0];
  }

  /**
   * Clear all errors
   */
  public clear(): void {
    this.errors.clear();
  }

  /**
   * Check workflow state for new errors
   */
  private checkForNewErrors(workflowState: WorkflowState): void {
    for (const phase of workflowState.phases) {
      for (const step of phase.steps) {
        if (step.status === 'failed' && step.error) {
          const key = `${phase.name}:${step.name}`;
          if (!this.errors.has(key)) {
            const error = this.analyzeError(step, phase, workflowState);
            this.errors.set(error.id, error);
            this.onErrorAddedEmitter.fire(error);
          }
        }
      }
    }
  }

  /**
   * Analyze an error and create detailed analysis
   */
  private analyzeError(step: StepState, phase: PhaseState, workflow: WorkflowState): AnalyzedError {
    const id = `error-${++this.errorIdCounter}`;
    const message = step.error ?? 'Unknown error';
    const category = this.categorizeError(message, step.exitCode);
    const stackTrace = this.buildStackTrace(step, phase, workflow);
    const suggestions = this.generateSuggestions(message, category, step);

    return {
      id,
      timestamp: step.endTime ?? Date.now(),
      message,
      category,
      severity: 'error',
      phaseName: phase.name,
      stepName: step.name,
      exitCode: step.exitCode,
      stackTrace,
      rawOutput: step.output,
      suggestions,
    };
  }

  /**
   * Categorize error based on message and exit code
   */
  private categorizeError(message: string, exitCode?: number): ErrorCategory {
    const lowerMessage = message.toLowerCase();

    // Check for timeout
    if (lowerMessage.includes('timeout') || lowerMessage.includes('timed out')) {
      return 'timeout';
    }

    // Check for permission errors
    if (
      lowerMessage.includes('permission denied') ||
      lowerMessage.includes('access denied') ||
      lowerMessage.includes('eacces') ||
      exitCode === 126
    ) {
      return 'permission';
    }

    // Check for network errors
    if (
      lowerMessage.includes('network') ||
      lowerMessage.includes('connection refused') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('dns') ||
      lowerMessage.includes('socket')
    ) {
      return 'network';
    }

    // Check for validation errors
    if (
      lowerMessage.includes('validation') ||
      lowerMessage.includes('invalid') ||
      lowerMessage.includes('schema')
    ) {
      return 'validation';
    }

    // Check for configuration errors
    if (
      lowerMessage.includes('config') ||
      lowerMessage.includes('not found') ||
      lowerMessage.includes('missing') ||
      exitCode === 127
    ) {
      return 'configuration';
    }

    // Check for execution errors based on exit code
    if (exitCode !== undefined && exitCode !== 0) {
      return 'execution';
    }

    return 'unknown';
  }

  /**
   * Build stack trace from current state
   */
  private buildStackTrace(step: StepState, phase: PhaseState, workflow: WorkflowState): StackTraceFrame[] {
    const frames: StackTraceFrame[] = [];

    // Add step frame
    frames.push({
      index: 0,
      name: `${step.name} (step)`,
      phaseName: phase.name,
      stepName: step.name,
      source: workflow.filePath,
      variables: Object.fromEntries(step.variables),
    });

    // Add phase frame
    frames.push({
      index: 1,
      name: `${phase.name} (phase)`,
      phaseName: phase.name,
      source: workflow.filePath,
      variables: Object.fromEntries(phase.variables),
    });

    // Add workflow frame
    frames.push({
      index: 2,
      name: `${workflow.name} (workflow)`,
      phaseName: workflow.name,
      source: workflow.filePath,
      variables: Object.fromEntries(workflow.variables),
    });

    return frames;
  }

  /**
   * Generate suggestions based on error
   */
  private generateSuggestions(message: string, category: ErrorCategory, step: StepState): string[] {
    const suggestions: string[] = [];

    switch (category) {
      case 'timeout':
        suggestions.push('Increase the step timeout value');
        suggestions.push('Check if the command is waiting for user input');
        suggestions.push('Verify network connectivity if the step makes remote calls');
        break;

      case 'permission':
        suggestions.push('Check file/directory permissions');
        suggestions.push('Ensure the user has required access rights');
        suggestions.push('Try running with elevated privileges if appropriate');
        break;

      case 'network':
        suggestions.push('Verify network connectivity');
        suggestions.push('Check if the target service is running');
        suggestions.push('Verify firewall settings');
        suggestions.push('Check DNS resolution');
        break;

      case 'configuration':
        suggestions.push('Verify required files exist');
        suggestions.push('Check environment variables are set correctly');
        suggestions.push('Ensure all dependencies are installed');
        break;

      case 'execution':
        if (step.exitCode === 1) {
          suggestions.push('Check the command output for specific error details');
        } else if (step.exitCode === 127) {
          suggestions.push('Command not found - check if it\'s installed and in PATH');
        } else if (step.exitCode === 126) {
          suggestions.push('Permission denied - check file permissions');
        } else if (step.exitCode === 128) {
          suggestions.push('Invalid exit argument');
        } else if (step.exitCode && step.exitCode > 128) {
          const signal = step.exitCode - 128;
          suggestions.push(`Process terminated by signal ${signal}`);
        }
        break;

      case 'validation':
        suggestions.push('Check input data format');
        suggestions.push('Verify schema requirements');
        suggestions.push('Review validation rules');
        break;

      default:
        suggestions.push('Review the error message for more details');
        suggestions.push('Check the step output for additional context');
        suggestions.push('Try running the step manually to debug');
    }

    // Add generic suggestions
    suggestions.push('Use "Replay From Step" to re-run from a previous point');

    return suggestions;
  }

  /**
   * Dispose resources
   */
  public dispose(): void {
    this.errors.clear();
    this.onErrorAddedEmitter.dispose();
  }

  /**
   * Reset singleton (for testing)
   */
  public static resetInstance(): void {
    ErrorAnalysisManager.instance?.dispose();
    ErrorAnalysisManager.instance = undefined;
  }
}

/**
 * Error tree item for display
 */
export class ErrorTreeItem extends vscode.TreeItem {
  constructor(
    public readonly error: AnalyzedError,
    public readonly frameIndex?: number
  ) {
    super(
      frameIndex !== undefined
        ? error.stackTrace[frameIndex]?.name ?? 'Unknown'
        : error.message,
      frameIndex !== undefined
        ? vscode.TreeItemCollapsibleState.None
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    if (frameIndex !== undefined) {
      // Stack frame item
      const frame = error.stackTrace[frameIndex];
      this.description = frame?.phaseName;
      this.iconPath = new vscode.ThemeIcon('symbol-method');
      this.contextValue = 'errorStackFrame';
    } else {
      // Error item
      this.description = `${error.phaseName}${error.stepName ? `:${error.stepName}` : ''}`;
      this.iconPath = this.getIconForSeverity(error.severity);
      this.tooltip = this.createTooltip();
      this.contextValue = 'error';
    }
  }

  private getIconForSeverity(severity: ErrorSeverity): vscode.ThemeIcon {
    switch (severity) {
      case 'error':
        return new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      case 'warning':
        return new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
      case 'info':
        return new vscode.ThemeIcon('info', new vscode.ThemeColor('editorInfo.foreground'));
      default:
        return new vscode.ThemeIcon('circle-outline');
    }
  }

  private createTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`### ${this.error.category.charAt(0).toUpperCase() + this.error.category.slice(1)} Error\n\n`);
    md.appendMarkdown(`**Message:** ${this.error.message}\n\n`);
    md.appendMarkdown(`**Location:** ${this.error.phaseName}:${this.error.stepName ?? 'start'}\n\n`);

    if (this.error.exitCode !== undefined) {
      md.appendMarkdown(`**Exit Code:** ${this.error.exitCode}\n\n`);
    }

    if (this.error.suggestions.length > 0) {
      md.appendMarkdown(`**Suggestions:**\n`);
      for (const suggestion of this.error.suggestions) {
        md.appendMarkdown(`- ${suggestion}\n`);
      }
    }

    return md;
  }
}

/**
 * Error analysis tree view provider
 */
export class ErrorAnalysisProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private manager: ErrorAnalysisManager;
  private subscription: vscode.Disposable;

  constructor() {
    this.manager = ErrorAnalysisManager.getInstance();
    this.subscription = this.manager.onErrorAdded(() => {
      this.refresh();
    });
  }

  public refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (!element) {
      // Root level - return all errors
      const errors = this.manager.getAllErrors();

      if (errors.length === 0) {
        return [
          new vscode.TreeItem(
            'No errors detected',
            vscode.TreeItemCollapsibleState.None
          ),
        ];
      }

      return errors.map(e => new ErrorTreeItem(e));
    }

    if (element instanceof ErrorTreeItem && element.frameIndex === undefined) {
      // Show stack frames and suggestions
      const items: vscode.TreeItem[] = [];

      // Add stack trace header
      const stackHeader = new vscode.TreeItem(
        'Stack Trace',
        vscode.TreeItemCollapsibleState.Expanded
      );
      stackHeader.iconPath = new vscode.ThemeIcon('call-hierarchy-outgoing');

      // Add frames as children
      for (let i = 0; i < element.error.stackTrace.length; i++) {
        items.push(new ErrorTreeItem(element.error, i));
      }

      // Add suggestions
      if (element.error.suggestions.length > 0) {
        const suggestionsItem = new vscode.TreeItem(
          `💡 ${element.error.suggestions.length} suggestions`,
          vscode.TreeItemCollapsibleState.None
        );
        suggestionsItem.tooltip = element.error.suggestions.join('\n• ');
        suggestionsItem.contextValue = 'errorSuggestions';
        items.push(suggestionsItem);
      }

      return items;
    }

    return [];
  }

  public dispose(): void {
    this.subscription.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }
}

/**
 * Register error analysis panel and commands
 */
export function registerErrorAnalysis(context: vscode.ExtensionContext): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];
  const manager = ErrorAnalysisManager.getInstance();

  // Create provider
  const provider = new ErrorAnalysisProvider();
  disposables.push(provider);

  // Register tree view
  const treeView = vscode.window.createTreeView('generacy.debugErrors', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  disposables.push(treeView);

  // Register commands
  disposables.push(
    vscode.commands.registerCommand('generacy.debug.refreshErrors', () => {
      provider.refresh();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.clearErrors', () => {
      manager.clear();
      provider.refresh();
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.copyError', (item: ErrorTreeItem) => {
      if (item.error) {
        const text = JSON.stringify(item.error, null, 2);
        vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage('Error details copied to clipboard');
      }
    })
  );

  disposables.push(
    vscode.commands.registerCommand('generacy.debug.showErrorDetails', async (item: ErrorTreeItem) => {
      const error = item.error;

      const content = `# Error Analysis

## ${error.category.charAt(0).toUpperCase() + error.category.slice(1)} Error

**Message:** ${error.message}

**Location:** ${error.phaseName}:${error.stepName ?? 'start'}

**Time:** ${new Date(error.timestamp).toLocaleString()}

${error.exitCode !== undefined ? `**Exit Code:** ${error.exitCode}` : ''}

## Stack Trace

${error.stackTrace.map((f, i) => `${i}. ${f.name} (${f.phaseName})`).join('\n')}

## Suggestions

${error.suggestions.map(s => `- ${s}`).join('\n')}

${error.rawOutput ? `## Raw Output\n\n\`\`\`\n${error.rawOutput}\n\`\`\`` : ''}
`;

      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content,
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    })
  );

  // Show notification when new error is detected
  disposables.push(
    manager.onErrorAdded(error => {
      vscode.window.showErrorMessage(
        `Workflow error: ${error.message}`,
        'View Details'
      ).then(selection => {
        if (selection === 'View Details') {
          vscode.commands.executeCommand('generacy.debugErrors.focus');
        }
      });
    })
  );

  return disposables;
}

/**
 * Get the error analysis manager
 */
export function getErrorAnalysisManager(): ErrorAnalysisManager {
  return ErrorAnalysisManager.getInstance();
}
