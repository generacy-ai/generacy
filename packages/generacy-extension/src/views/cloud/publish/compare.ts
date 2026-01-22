/**
 * Diff comparison view for workflow publishing.
 *
 * This module provides functionality to display side-by-side diff views
 * comparing local workflow files with their cloud-published versions.
 */

import * as vscode from 'vscode';
import { getPublishedWorkflow } from '../../../api/endpoints/workflows';
import { CloudWorkflowContentProvider } from './provider';

/**
 * Content provider instance for cloud workflows.
 * Registered once globally to handle all cloud workflow URIs.
 */
let contentProvider: CloudWorkflowContentProvider | undefined;

/**
 * Registers the cloud workflow content provider with VS Code.
 *
 * This function should be called once during extension activation
 * to enable cloud workflow URIs in diff views.
 *
 * @param context - Extension context for disposable registration
 *
 * @example
 * ```typescript
 * export function activate(context: vscode.ExtensionContext) {
 *   registerCloudWorkflowProvider(context);
 * }
 * ```
 */
export function registerCloudWorkflowProvider(context: vscode.ExtensionContext): void {
  if (!contentProvider) {
    contentProvider = new CloudWorkflowContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider('generacy-cloud', contentProvider)
    );
  }
}

/**
 * Shows a diff view comparing local and cloud versions of a workflow.
 *
 * Opens VS Code's native diff editor with:
 * - Left side: Cloud version (read-only)
 * - Right side: Local version (editable)
 *
 * @param workflowName - The name of the workflow (without .yaml extension)
 * @param localFileUri - URI of the local workflow file
 * @returns Promise that resolves when diff view opens
 *
 * @example
 * ```typescript
 * const localUri = vscode.Uri.file('.generacy/ci-workflow.yaml');
 * await showWorkflowDiff('ci-workflow', localUri);
 * ```
 */
export async function showWorkflowDiff(workflowName: string, localFileUri: vscode.Uri): Promise<void> {
  try {
    // Fetch cloud workflow details to get current version
    const cloudWorkflow = await getPublishedWorkflow(workflowName);

    // Create cloud URI for the latest version
    const cloudUri = vscode.Uri.parse(
      `generacy-cloud://workflow/${workflowName}/${cloudWorkflow.currentVersion}`
    );

    // Open diff editor
    await vscode.commands.executeCommand(
      'vscode.diff',
      cloudUri, // Left side (cloud)
      localFileUri, // Right side (local)
      `${workflowName}: Cloud (v${cloudWorkflow.currentVersion}) ↔ Local`
    );
  } catch (error: any) {
    // Handle specific error cases
    if (error.statusCode === 404) {
      vscode.window.showErrorMessage(
        `Workflow "${workflowName}" has not been published to the cloud yet.`
      );
      return;
    }

    if (error.statusCode === 401) {
      vscode.window.showErrorMessage(
        'Authentication required. Please sign in to view cloud workflows.',
        'Sign In'
      ).then((action) => {
        if (action === 'Sign In') {
          vscode.commands.executeCommand('generacy.signIn');
        }
      });
      return;
    }

    // Generic error
    vscode.window.showErrorMessage(
      `Failed to show workflow diff: ${error.message || 'Unknown error'}`
    );
  }
}

/**
 * Command handler for comparing the current workflow with its cloud version.
 *
 * Gets the active editor's workflow file and opens a diff view.
 * This is registered as the `generacy.compareWithCloud` command.
 *
 * @returns Promise that resolves when diff view opens or user cancels
 *
 * @example
 * ```typescript
 * // In extension.ts
 * context.subscriptions.push(
 *   vscode.commands.registerCommand('generacy.compareWithCloud', compareWithCloudCommand)
 * );
 * ```
 */
export async function compareWithCloudCommand(): Promise<void> {
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

  await showWorkflowDiff(workflowName, fileUri);
}
