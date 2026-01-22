/**
 * Workflow publishing synchronization commands.
 *
 * This module provides the main command handler for publishing workflows
 * to the cloud, including validation, diff display, changelog prompts,
 * and confirmation flows.
 */

import * as vscode from 'vscode';
import { publishWorkflow } from '../../../api/endpoints/workflows';
import { validateWorkflowContent } from './validation';
import { syncStatusCache } from './cache';
import { determineSyncStatus } from './status';
import { showWorkflowDiff } from './compare';

// ============================================================================
// Main Publish Command
// ============================================================================

/**
 * Command handler for publishing a workflow to the cloud.
 *
 * Flow:
 * 1. Get active workflow file from editor
 * 2. Validate workflow YAML
 * 3. Check authentication status
 * 4. Fetch cloud version if exists
 * 5. Show diff if cloud version exists
 * 6. Prompt for changelog
 * 7. Show confirmation QuickPick
 * 8. Publish to cloud API
 * 9. Show success message
 * 10. Invalidate cache
 *
 * @returns Promise that resolves when publish completes or user cancels
 */
export async function publishWorkflowCommand(): Promise<void> {
  try {
    // 1. Get active workflow file
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor. Please open a workflow file.');
      return;
    }

    const fileUri = editor.document.uri;
    const fileName = fileUri.path.split('/').pop() || '';

    // Verify it's a workflow file (.yaml in .generacy/ directory)
    if (!fileName.endsWith('.yaml') || !fileUri.path.includes('.generacy/')) {
      vscode.window.showErrorMessage('Please open a workflow file (.yaml) from the .generacy/ directory.');
      return;
    }

    const workflowName = fileName.replace('.yaml', '');
    const content = editor.document.getText();

    // 2. Validate workflow YAML
    const validationResult = validateWorkflowContent(content);
    if (!validationResult.valid) {
      vscode.window.showErrorMessage(`Workflow validation failed: ${validationResult.error}`);
      return;
    }

    // 3. Check authentication status (implicitly checked by API client)
    // The API client will throw auth errors if not authenticated

    // 4. Fetch cloud version if exists (to show diff)
    const syncStatus = await determineSyncStatus(
      workflowName,
      content,
      editor.document.uri.scheme === 'file'
        ? (await vscode.workspace.fs.stat(fileUri)).mtime
        : Date.now()
    );

    // 5. Show diff if cloud version exists
    if (syncStatus !== 'not-published' && syncStatus !== 'unknown') {
      const viewDiff = await vscode.window.showQuickPick(
        [
          {
            label: '$(diff) Review Changes',
            description: 'View differences between local and cloud versions',
            action: 'diff',
          },
          {
            label: '$(cloud-upload) Continue Publishing',
            description: 'Skip diff and proceed with publishing',
            action: 'continue',
          },
          {
            label: '$(x) Cancel',
            action: 'cancel',
          },
        ],
        {
          placeHolder: `Cloud version exists (Status: ${syncStatus}). Review changes before publishing?`,
          ignoreFocusOut: true,
        }
      );

      if (!viewDiff || viewDiff.action === 'cancel') {
        return;
      }

      if (viewDiff.action === 'diff') {
        await showWorkflowDiff(workflowName, fileUri);
        // After showing diff, ask if user wants to proceed
        const proceed = await vscode.window.showQuickPick(
          [
            {
              label: '$(cloud-upload) Publish Now',
              action: 'publish',
            },
            {
              label: '$(x) Cancel',
              action: 'cancel',
            },
          ],
          {
            placeHolder: 'Proceed with publishing?',
            ignoreFocusOut: true,
          }
        );

        if (!proceed || proceed.action === 'cancel') {
          return;
        }
      }
    }

    // 6. Prompt for changelog
    const changelog = await vscode.window.showInputBox({
      prompt: 'Describe what changed in this version (optional but recommended)',
      placeHolder: 'Added deployment phase, updated test configuration, etc.',
      ignoreFocusOut: true,
      validateInput: (value) => {
        return value.length > 500 ? 'Changelog too long (max 500 characters)' : undefined;
      },
    });

    // User cancelled changelog input
    if (changelog === undefined) {
      return;
    }

    // 7. Show confirmation QuickPick
    const confirmation = await vscode.window.showQuickPick(
      [
        {
          label: '$(cloud-upload) Publish Now',
          description: changelog || 'No changelog provided',
          action: 'publish',
        },
        {
          label: '$(x) Cancel',
          action: 'cancel',
        },
      ],
      {
        placeHolder: `Publishing workflow: ${workflowName}`,
        ignoreFocusOut: true,
      }
    );

    if (!confirmation || confirmation.action === 'cancel') {
      return;
    }

    // 8. Publish to cloud with progress indicator
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Publishing ${workflowName}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ increment: 0, message: 'Uploading...' });

        try {
          const result = await publishWorkflow({
            name: workflowName,
            content,
            changelog: changelog || undefined,
          });

          progress.report({ increment: 80, message: 'Updating status...' });

          // 9. Invalidate sync status cache
          syncStatusCache.invalidate(workflowName);

          progress.report({ increment: 100, message: 'Done!' });

          // 10. Show success message
          vscode.window.showInformationMessage(
            `✓ Published ${workflowName} as version ${result.version}`
          );
        } catch (error: any) {
          // Handle publish errors
          if (error.statusCode === 401) {
            vscode.window.showErrorMessage(
              'Authentication expired. Please sign in again.',
              'Sign In'
            ).then((action) => {
              if (action === 'Sign In') {
                vscode.commands.executeCommand('generacy.signIn');
              }
            });
          } else if (error.statusCode === 403) {
            vscode.window.showErrorMessage(
              "You don't have permission to publish workflows to this organization."
            );
          } else if (error.statusCode === 409) {
            vscode.window.showErrorMessage(
              'Cloud version has changed. Please review differences and try again.'
            );
          } else {
            vscode.window.showErrorMessage(
              `Failed to publish workflow: ${error.message || 'Unknown error'}`
            );
          }
          throw error;
        }
      }
    );
  } catch (error: any) {
    // Top-level error handler
    console.error('Error in publishWorkflowCommand:', error);
    // Error already shown to user in withProgress block
  }
}
