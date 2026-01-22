/**
 * Version history and rollback functionality for workflow publishing.
 *
 * This module provides commands for viewing workflow version history,
 * comparing versions, and rolling back to previous versions.
 */

import * as vscode from 'vscode';
import { getWorkflowVersions, getWorkflowVersion, publishWorkflow } from '../../../api/endpoints/workflows';
import { syncStatusCache } from './cache';
import { showWorkflowDiff } from './compare';

// ============================================================================
// Version History Display
// ============================================================================

/**
 * Shows a QuickPick menu displaying the version history of a workflow.
 *
 * Features:
 * - Lists all versions with metadata (version number, tag, timestamp, changelog)
 * - Sorted newest first
 * - Action buttons: View, Compare to Local, Rollback
 *
 * @param workflowName - The name of the workflow (without .yaml extension)
 * @returns Promise that resolves when user closes the QuickPick
 *
 * @example
 * ```typescript
 * await showVersionHistory('ci-workflow');
 * ```
 */
export async function showVersionHistory(workflowName: string): Promise<void> {
  try {
    // Fetch version history from API
    const versions = await getWorkflowVersions(workflowName);

    if (versions.length === 0) {
      vscode.window.showInformationMessage(`Workflow "${workflowName}" has no published versions.`);
      return;
    }

    // Create QuickPick items
    const quickPick = vscode.window.createQuickPick<
      vscode.QuickPickItem & {
        version: number;
        tag?: string;
      }
    >();

    quickPick.title = `Version History: ${workflowName}`;
    quickPick.placeholder = 'Select a version to view details';

    quickPick.items = versions.map((v) => ({
      label: `$(tag) Version ${v.version}${v.tag ? ` (${v.tag})` : ''}`,
      description: new Date(v.publishedAt).toLocaleString(),
      detail: v.changelog || 'No changelog provided',
      version: v.version,
      tag: v.tag,
      buttons: [
        {
          iconPath: new vscode.ThemeIcon('eye'),
          tooltip: 'View this version',
        },
        {
          iconPath: new vscode.ThemeIcon('diff'),
          tooltip: 'Compare with local',
        },
        {
          iconPath: new vscode.ThemeIcon('history'),
          tooltip: 'Rollback to this version',
        },
      ],
    }));

    // Handle button clicks
    quickPick.onDidTriggerItemButton(async (event) => {
      const item = event.item as vscode.QuickPickItem & { version: number };
      const button = event.button;

      if (button.tooltip === 'View this version') {
        // View: Open version content in read-only editor
        await viewWorkflowVersion(workflowName, item.version);
      } else if (button.tooltip === 'Compare with local') {
        // Compare: Show diff with local file
        await compareVersionWithLocal(workflowName, item.version);
      } else if (button.tooltip === 'Rollback to this version') {
        // Rollback: Publish this version as new version
        await rollbackToVersion(workflowName, item.version);
        quickPick.hide();
      }
    });

    // Handle item selection (optional: show details)
    quickPick.onDidAccept(() => {
      const selected = quickPick.selectedItems[0] as vscode.QuickPickItem & { version: number };
      if (selected) {
        vscode.window.showInformationMessage(
          `Version ${selected.version}: ${selected.detail}`,
          'View',
          'Compare',
          'Rollback'
        ).then(async (action) => {
          if (action === 'View') {
            await viewWorkflowVersion(workflowName, selected.version);
          } else if (action === 'Compare') {
            await compareVersionWithLocal(workflowName, selected.version);
          } else if (action === 'Rollback') {
            await rollbackToVersion(workflowName, selected.version);
          }
          quickPick.hide();
        });
      }
    });

    quickPick.show();
  } catch (error: any) {
    if (error.statusCode === 404) {
      vscode.window.showInformationMessage(`Workflow "${workflowName}" has not been published to the cloud yet.`);
      return;
    }

    if (error.statusCode === 401) {
      vscode.window.showErrorMessage(
        'Authentication required. Please sign in to view version history.',
        'Sign In'
      ).then((action) => {
        if (action === 'Sign In') {
          vscode.commands.executeCommand('generacy.signIn');
        }
      });
      return;
    }

    vscode.window.showErrorMessage(
      `Failed to load version history: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Command handler for viewing workflow version history.
 *
 * Gets the active editor's workflow and opens the version history QuickPick.
 * Registered as the `generacy.viewVersionHistory` command.
 *
 * @returns Promise that resolves when version history is displayed or user cancels
 */
export async function viewVersionHistoryCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showErrorMessage('No active editor. Please open a workflow file.');
    return;
  }

  const fileUri = editor.document.uri;
  const fileName = fileUri.path.split('/').pop() || '';

  // Verify it's a workflow file
  if (!fileName.endsWith('.yaml') || !fileUri.path.includes('.generacy/')) {
    vscode.window.showErrorMessage('Please open a workflow file (.yaml) from the .generacy/ directory.');
    return;
  }

  const workflowName = fileName.replace('.yaml', '');

  await showVersionHistory(workflowName);
}

// ============================================================================
// Version Actions
// ============================================================================

/**
 * Opens a specific workflow version in a read-only editor.
 *
 * @param workflowName - The name of the workflow
 * @param version - The version number to view
 */
async function viewWorkflowVersion(workflowName: string, version: number): Promise<void> {
  try {
    const content = await getWorkflowVersion(workflowName, version);

    // Create virtual document
    const uri = vscode.Uri.parse(`generacy-cloud://workflow/${workflowName}/${version}`);

    // Open in editor
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: false,
    });
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to view version ${version}: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Shows a diff comparing a specific version with the current local file.
 *
 * @param workflowName - The name of the workflow
 * @param version - The version number to compare
 */
async function compareVersionWithLocal(workflowName: string, version: number): Promise<void> {
  try {
    // Find local workflow file
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('No workspace folder open.');
      return;
    }

    const localUri = vscode.Uri.joinPath(workspaceFolder.uri, '.generacy', `${workflowName}.yaml`);

    // Check if local file exists
    try {
      await vscode.workspace.fs.stat(localUri);
    } catch {
      vscode.window.showErrorMessage(`Local workflow file not found: ${workflowName}.yaml`);
      return;
    }

    // Create cloud URI for specific version
    const cloudUri = vscode.Uri.parse(`generacy-cloud://workflow/${workflowName}/${version}`);

    // Open diff
    await vscode.commands.executeCommand(
      'vscode.diff',
      cloudUri,
      localUri,
      `${workflowName}: Cloud (v${version}) ↔ Local`
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to compare version ${version}: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Rolls back a workflow to a previous version by publishing it as a new version.
 *
 * This is a non-destructive operation that creates a new version containing
 * the content of the target version. The version history is preserved.
 *
 * @param workflowName - The name of the workflow
 * @param targetVersion - The version number to rollback to
 */
async function rollbackToVersion(workflowName: string, targetVersion: number): Promise<void> {
  try {
    // Show confirmation dialog
    const confirmation = await vscode.window.showWarningMessage(
      `Rollback "${workflowName}" to version ${targetVersion}?`,
      {
        modal: true,
        detail: `This will create a new version with the content from version ${targetVersion}. ` +
          `The version history will be preserved (non-destructive rollback).`,
      },
      'Rollback',
      'Cancel'
    );

    if (confirmation !== 'Rollback') {
      return;
    }

    // Fetch target version content
    const content = await getWorkflowVersion(workflowName, targetVersion);

    // Publish as new version with rollback changelog
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Rolling back ${workflowName} to version ${targetVersion}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0, message: 'Fetching version...' });

        const result = await publishWorkflow({
          name: workflowName,
          content,
          changelog: `Rolled back to version ${targetVersion}`,
        });

        progress.report({ increment: 80, message: 'Updating status...' });

        // Invalidate cache
        syncStatusCache.invalidate(workflowName);

        progress.report({ increment: 100, message: 'Done!' });

        // Ask if user wants to update local file
        const updateLocal = await vscode.window.showInformationMessage(
          `✓ Rolled back to version ${targetVersion} (new version: ${result.version})`,
          'Update Local File',
          'Keep Local As-Is'
        );

        if (updateLocal === 'Update Local File') {
          // Find and update local file
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (workspaceFolder) {
            const localUri = vscode.Uri.joinPath(workspaceFolder.uri, '.generacy', `${workflowName}.yaml`);

            try {
              await vscode.workspace.fs.writeFile(localUri, Buffer.from(content, 'utf8'));
              vscode.window.showInformationMessage('✓ Local file updated');
            } catch (error: any) {
              vscode.window.showErrorMessage(`Failed to update local file: ${error.message}`);
            }
          }
        }
      }
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to rollback to version ${targetVersion}: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Command handler for rolling back a workflow to a specific version.
 *
 * Prompts the user to select a version and then performs the rollback.
 * Registered as the `generacy.rollbackWorkflow` command.
 *
 * @returns Promise that resolves when rollback completes or user cancels
 */
export async function rollbackWorkflowCommand(): Promise<void> {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    vscode.window.showErrorMessage('No active editor. Please open a workflow file.');
    return;
  }

  const fileUri = editor.document.uri;
  const fileName = fileUri.path.split('/').pop() || '';

  // Verify it's a workflow file
  if (!fileName.endsWith('.yaml') || !fileUri.path.includes('.generacy/')) {
    vscode.window.showErrorMessage('Please open a workflow file (.yaml) from the .generacy/ directory.');
    return;
  }

  const workflowName = fileName.replace('.yaml', '');

  // Fetch versions and show selection
  try {
    const versions = await getWorkflowVersions(workflowName);

    if (versions.length === 0) {
      vscode.window.showInformationMessage(`Workflow "${workflowName}" has no published versions to rollback to.`);
      return;
    }

    const selected = await vscode.window.showQuickPick(
      versions.map((v) => ({
        label: `Version ${v.version}${v.tag ? ` (${v.tag})` : ''}`,
        description: new Date(v.publishedAt).toLocaleString(),
        detail: v.changelog || 'No changelog',
        version: v.version,
      })),
      {
        placeHolder: 'Select a version to rollback to',
        ignoreFocusOut: true,
      }
    );

    if (selected) {
      await rollbackToVersion(workflowName, selected.version);
    }
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `Failed to rollback workflow: ${error.message || 'Unknown error'}`
    );
  }
}
