/**
 * Cloud workflow content provider for VS Code diff editor.
 *
 * This module provides a TextDocumentContentProvider that fetches
 * workflow content from the cloud API, enabling diff comparison
 * between local and cloud versions.
 */

import * as vscode from 'vscode';
import { getWorkflowVersion } from '../../../api/endpoints/workflows';

/**
 * Content provider for cloud-hosted workflows.
 *
 * Implements VS Code's TextDocumentContentProvider to enable reading
 * workflow content from the cloud API using custom URIs.
 *
 * URI format: `generacy-cloud://workflow/{workflowName}/{version}`
 *
 * @example
 * ```typescript
 * // Register provider
 * context.subscriptions.push(
 *   vscode.workspace.registerTextDocumentContentProvider(
 *     'generacy-cloud',
 *     new CloudWorkflowContentProvider()
 *   )
 * );
 *
 * // Use in diff command
 * const cloudUri = vscode.Uri.parse('generacy-cloud://workflow/ci-workflow/3');
 * const localUri = vscode.Uri.file('/path/to/ci-workflow.yaml');
 * await vscode.commands.executeCommand('vscode.diff', cloudUri, localUri, 'CI Workflow: Cloud ↔ Local');
 * ```
 */
export class CloudWorkflowContentProvider implements vscode.TextDocumentContentProvider {
  /**
   * Provides the text content for a cloud workflow URI.
   *
   * Parses the URI to extract workflow name and version number,
   * then fetches the content from the cloud API.
   *
   * @param uri - The cloud workflow URI to fetch content for
   * @returns Promise resolving to the workflow YAML content as a string
   * @throws Error if URI is malformed or API fetch fails
   */
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      // Parse URI: generacy-cloud://workflow/{workflowName}/{version}
      const pathParts = uri.path.split('/').filter(Boolean);

      if (pathParts.length < 2 || pathParts[0] !== 'workflow') {
        throw new Error('Invalid cloud workflow URI format. Expected: generacy-cloud://workflow/{name}/{version}');
      }

      const workflowName = pathParts[1];
      const versionStr = pathParts[2];

      if (!versionStr) {
        throw new Error('Missing version in cloud workflow URI');
      }

      const version = parseInt(versionStr, 10);

      if (isNaN(version) || version <= 0) {
        throw new Error(`Invalid version number: ${versionStr}`);
      }

      // Fetch workflow content from cloud API
      const content = await getWorkflowVersion(workflowName, version);

      return content;
    } catch (error: any) {
      // Handle specific error cases
      if (error.statusCode === 404) {
        throw new Error(`Workflow version not found: ${uri.toString()}`);
      }

      if (error.statusCode === 401) {
        throw new Error('Authentication required. Please sign in to view cloud workflows.');
      }

      // Generic error
      throw new Error(`Failed to load cloud workflow: ${error.message || 'Unknown error'}`);
    }
  }
}
