/**
 * File decorations for workflow validation status.
 * Provides visual indicators for valid/invalid/unknown workflow files.
 */
import * as vscode from 'vscode';
import { getLogger } from '../../../utils';
import { ValidationStatus } from './tree-item';

/**
 * Decoration data for a workflow file
 */
export interface WorkflowDecorationData {
  uri: vscode.Uri;
  status: ValidationStatus;
  error?: string;
}

/**
 * WorkflowDecorationProvider provides file decorations for workflow files
 * to indicate their validation status in the file explorer and tree views.
 */
export class WorkflowDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri | vscode.Uri[] | undefined
  >();
  public readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private readonly decorationCache = new Map<string, vscode.FileDecoration>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    const logger = getLogger();
    logger.debug('WorkflowDecorationProvider initialized');
  }

  /**
   * Provide decoration for a URI
   */
  public provideFileDecoration(
    uri: vscode.Uri,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.FileDecoration> {
    const key = uri.toString();
    return this.decorationCache.get(key);
  }

  /**
   * Update decoration for a workflow file
   */
  public updateDecoration(data: WorkflowDecorationData): void {
    const key = data.uri.toString();
    const decoration = this.createDecoration(data.status, data.error);

    if (decoration) {
      this.decorationCache.set(key, decoration);
    } else {
      this.decorationCache.delete(key);
    }

    this._onDidChangeFileDecorations.fire(data.uri);
  }

  /**
   * Update decorations for multiple files
   */
  public updateDecorations(items: WorkflowDecorationData[]): void {
    const uris: vscode.Uri[] = [];

    for (const item of items) {
      const key = item.uri.toString();
      const decoration = this.createDecoration(item.status, item.error);

      if (decoration) {
        this.decorationCache.set(key, decoration);
      } else {
        this.decorationCache.delete(key);
      }

      uris.push(item.uri);
    }

    if (uris.length > 0) {
      this._onDidChangeFileDecorations.fire(uris);
    }
  }

  /**
   * Remove decoration for a workflow file
   */
  public removeDecoration(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.decorationCache.has(key)) {
      this.decorationCache.delete(key);
      this._onDidChangeFileDecorations.fire(uri);
    }
  }

  /**
   * Clear all decorations
   */
  public clearDecorations(): void {
    const uris = Array.from(this.decorationCache.keys()).map((key) =>
      vscode.Uri.parse(key)
    );
    this.decorationCache.clear();

    if (uris.length > 0) {
      this._onDidChangeFileDecorations.fire(uris);
    }
  }

  /**
   * Create a file decoration based on validation status
   */
  private createDecoration(
    status: ValidationStatus,
    error?: string
  ): vscode.FileDecoration | undefined {
    switch (status) {
      case 'valid':
        return new vscode.FileDecoration(
          '\u2713', // Checkmark
          'Valid workflow',
          new vscode.ThemeColor('testing.iconPassed')
        );

      case 'invalid':
        return new vscode.FileDecoration(
          '\u2717', // X mark
          error ? `Invalid: ${error}` : 'Invalid workflow',
          new vscode.ThemeColor('testing.iconFailed')
        );

      case 'validating':
        return new vscode.FileDecoration(
          '\u27F3', // Refresh symbol
          'Validating...',
          new vscode.ThemeColor('editorWarning.foreground')
        );

      case 'unknown':
      default:
        // No decoration for unknown status
        return undefined;
    }
  }

  /**
   * Get decoration for a specific URI
   */
  public getDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.decorationCache.get(uri.toString());
  }

  /**
   * Check if a URI has a decoration
   */
  public hasDecoration(uri: vscode.Uri): boolean {
    return this.decorationCache.has(uri.toString());
  }

  /**
   * Dispose of resources
   */
  public dispose(): void {
    this._onDidChangeFileDecorations.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.decorationCache.clear();
  }
}

/**
 * Singleton instance for the decoration provider
 */
let decorationProviderInstance: WorkflowDecorationProvider | undefined;

/**
 * Get the singleton decoration provider instance
 */
export function getWorkflowDecorationProvider(): WorkflowDecorationProvider {
  if (!decorationProviderInstance) {
    decorationProviderInstance = new WorkflowDecorationProvider();
  }
  return decorationProviderInstance;
}

/**
 * Register the decoration provider with VS Code
 */
export function registerWorkflowDecorationProvider(
  context: vscode.ExtensionContext
): WorkflowDecorationProvider {
  const provider = getWorkflowDecorationProvider();

  // Register as a file decoration provider
  const registration = vscode.window.registerFileDecorationProvider(provider);

  context.subscriptions.push(registration);
  context.subscriptions.push(provider);

  return provider;
}

/**
 * Reset the singleton instance (for testing)
 */
export function resetWorkflowDecorationProvider(): void {
  decorationProviderInstance?.dispose();
  decorationProviderInstance = undefined;
}
