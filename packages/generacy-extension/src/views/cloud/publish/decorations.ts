/**
 * File decoration provider for workflow sync status indicators.
 *
 * This module provides VS Code FileDecorationProvider to display
 * sync status badges and colors in the file explorer for workflow files.
 */

import * as vscode from 'vscode';
import { getCachedSyncStatus } from './status';
import { SYNC_STATUS_ICONS, SYNC_STATUS_COLORS, type SyncStatus } from './types';
import { syncStatusCache } from './cache';

/**
 * File decoration provider that shows sync status indicators for workflows.
 *
 * Decorates workflow files (.yaml in .generacy/ directory) with badges
 * indicating their synchronization status with the cloud.
 *
 * Status decorations:
 * - ✓ (green): Synced with cloud
 * - ↑ (yellow): Local changes ahead of cloud
 * - ↓ (blue): Cloud ahead of local
 * - ⚠ (red): Conflict detected
 * - ⊘ (gray): Not published
 * - ? (gray): Unknown status
 *
 * @example
 * ```typescript
 * const provider = new WorkflowSyncDecorationProvider();
 * context.subscriptions.push(
 *   vscode.window.registerFileDecorationProvider(provider)
 * );
 * ```
 */
export class WorkflowSyncDecorationProvider implements vscode.FileDecorationProvider {
  /**
   * Event emitter for decoration changes.
   * Fires when decorations need to be refreshed.
   */
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

  /**
   * Event fired when file decorations change.
   * VS Code listens to this to know when to refresh decorations.
   */
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /**
   * Provides file decoration for a given URI.
   *
   * Only decorates workflow files (.yaml in .generacy/ directory).
   * Returns undefined for non-workflow files.
   *
   * @param uri - The file URI to provide decoration for
   * @returns Promise resolving to FileDecoration or undefined
   */
  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    // Only decorate workflow files
    if (!this.isWorkflowFile(uri)) {
      return undefined;
    }

    try {
      // Extract workflow name from URI
      const fileName = uri.path.split('/').pop() || '';
      const workflowName = fileName.replace('.yaml', '');

      // Get file content and modification time
      const stat = await vscode.workspace.fs.stat(uri);
      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf8');

      // Determine sync status (uses cache if available)
      const syncStatus = await getCachedSyncStatus(workflowName, content, stat.mtime);

      // Create decoration based on status
      return this.createDecoration(syncStatus.status);
    } catch (error: any) {
      // On error, show unknown status
      console.error(`Failed to determine sync status for ${uri.path}:`, error);
      return this.createDecoration('unknown');
    }
  }

  /**
   * Checks if a URI represents a workflow file.
   *
   * A workflow file must:
   * - Have .yaml extension
   * - Be located in a .generacy/ directory
   *
   * @param uri - The URI to check
   * @returns True if the URI is a workflow file
   */
  private isWorkflowFile(uri: vscode.Uri): boolean {
    const path = uri.path;
    return path.endsWith('.yaml') && path.includes('.generacy/');
  }

  /**
   * Creates a FileDecoration for a given sync status.
   *
   * @param status - The sync status to create decoration for
   * @returns FileDecoration with badge, color, and tooltip
   */
  private createDecoration(status: SyncStatus): vscode.FileDecoration {
    const badge = SYNC_STATUS_ICONS[status];
    const color = new vscode.ThemeColor(SYNC_STATUS_COLORS[status]);
    const tooltip = this.getTooltip(status);

    return {
      badge,
      color,
      tooltip,
    };
  }

  /**
   * Gets tooltip text for a sync status.
   *
   * @param status - The sync status
   * @returns Human-readable tooltip description
   */
  private getTooltip(status: SyncStatus): string {
    switch (status) {
      case 'synced':
        return 'Up to date with cloud';
      case 'ahead':
        return 'Local changes not yet published';
      case 'behind':
        return 'Cloud has newer version';
      case 'conflict':
        return 'Both local and cloud have changes';
      case 'not-published':
        return 'Not published to cloud';
      case 'unknown':
        return 'Unable to determine status';
      default:
        return 'Unknown status';
    }
  }

  /**
   * Refreshes decorations for a specific workflow file.
   *
   * Call this after operations that change sync status (publish, rollback, file save).
   *
   * @param uri - The URI of the workflow file to refresh (optional, refreshes all if undefined)
   */
  refresh(uri?: vscode.Uri): void {
    this._onDidChangeFileDecorations.fire(uri);
  }

  /**
   * Refreshes decorations for all workflow files.
   *
   * Call this for global operations like authentication changes or manual refresh commands.
   */
  refreshAll(): void {
    this._onDidChangeFileDecorations.fire(undefined);
  }
}

/**
 * Singleton decoration provider instance.
 *
 * Use this shared instance throughout the extension to maintain
 * consistent decoration state.
 */
let decorationProvider: WorkflowSyncDecorationProvider | undefined;

/**
 * Gets or creates the singleton decoration provider.
 *
 * @returns The decoration provider instance
 */
export function getDecorationProvider(): WorkflowSyncDecorationProvider {
  if (!decorationProvider) {
    decorationProvider = new WorkflowSyncDecorationProvider();
  }
  return decorationProvider;
}

/**
 * Registers the workflow sync decoration provider with VS Code.
 *
 * Also sets up file watchers to invalidate cache and refresh decorations
 * when workflow files change.
 *
 * @param context - Extension context for disposable registration
 *
 * @example
 * ```typescript
 * export function activate(context: vscode.ExtensionContext) {
 *   registerDecorationProvider(context);
 * }
 * ```
 */
export function registerDecorationProvider(context: vscode.ExtensionContext): void {
  const provider = getDecorationProvider();

  // Register provider
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(provider)
  );

  // Set up file watcher for .generacy/**/*.yaml files
  const watcher = vscode.workspace.createFileSystemWatcher('**/.generacy/**/*.yaml');

  // Invalidate cache and refresh decoration on file save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (provider['isWorkflowFile'](document.uri)) {
        const fileName = document.uri.path.split('/').pop() || '';
        const workflowName = fileName.replace('.yaml', '');

        // Invalidate cache
        syncStatusCache.invalidate(workflowName);

        // Refresh decoration
        provider.refresh(document.uri);
      }
    })
  );

  // Refresh decoration when workflow files are created, changed, or deleted
  watcher.onDidCreate((uri) => {
    provider.refresh(uri);
  });

  watcher.onDidChange((uri) => {
    const fileName = uri.path.split('/').pop() || '';
    const workflowName = fileName.replace('.yaml', '');

    syncStatusCache.invalidate(workflowName);
    provider.refresh(uri);
  });

  watcher.onDidDelete((uri) => {
    const fileName = uri.path.split('/').pop() || '';
    const workflowName = fileName.replace('.yaml', '');

    syncStatusCache.invalidate(workflowName);
    provider.refresh(uri);
  });

  context.subscriptions.push(watcher);
}

/**
 * Command handler for manually refreshing sync status for all workflows.
 *
 * Clears the entire cache and refreshes all decorations.
 * Registered as the `generacy.refreshSyncStatus` command.
 *
 * @returns Promise that resolves when refresh completes
 */
export async function refreshSyncStatusCommand(): Promise<void> {
  syncStatusCache.invalidateAll();
  getDecorationProvider().refreshAll();
  vscode.window.showInformationMessage('✓ Sync status refreshed for all workflows');
}
