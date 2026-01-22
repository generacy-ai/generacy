/**
 * Sync status determination logic for workflow publishing.
 *
 * This module provides functionality to determine the synchronization status
 * between local workflow files and their cloud-published versions by comparing
 * content and modification timestamps.
 */

import * as vscode from 'vscode';
import type { SyncStatus, WorkflowSyncStatus } from './types';
import { getPublishedWorkflow, getWorkflowVersion } from '../../../api/endpoints/workflows';
import { syncStatusCache } from './cache';

// ============================================================================
// Core Status Determination
// ============================================================================

/**
 * Determines the synchronization status of a local workflow file relative to the cloud.
 *
 * The determination logic:
 * 1. If no cloud workflow exists -> 'not-published'
 * 2. If content matches exactly -> 'synced'
 * 3. If local modified after cloud publish -> 'ahead' (unpublished changes)
 * 4. If cloud published after local modify -> 'behind' (need to pull)
 *
 * @param workflowName - The name of the workflow (filename without extension)
 * @param localContent - The current local file content
 * @param localModifiedAt - Local file modification time (Unix timestamp)
 * @returns Promise resolving to the determined sync status
 *
 * @example
 * ```typescript
 * const fileUri = vscode.Uri.file('.generacy/my-workflow.yaml');
 * const stat = await vscode.workspace.fs.stat(fileUri);
 * const content = await vscode.workspace.fs.readFile(fileUri);
 *
 * const status = await determineSyncStatus(
 *   'my-workflow',
 *   Buffer.from(content).toString('utf8'),
 *   stat.mtime
 * );
 * ```
 */
export async function determineSyncStatus(
  workflowName: string,
  localContent: string,
  localModifiedAt: number
): Promise<SyncStatus> {
  try {
    // Check if workflow has been published to cloud
    let cloudWorkflow;
    try {
      cloudWorkflow = await getPublishedWorkflow(workflowName);
    } catch (error: any) {
      // 404 means not published yet
      if (error.statusCode === 404) {
        return 'not-published';
      }
      // Other errors (network, auth, etc.) -> unknown
      console.error(`Failed to fetch cloud workflow: ${error.message}`);
      return 'unknown';
    }

    // Fetch the latest cloud version content
    let cloudContent: string;
    try {
      cloudContent = await getWorkflowVersion(workflowName, cloudWorkflow.currentVersion);
    } catch (error: any) {
      console.error(`Failed to fetch cloud version content: ${error.message}`);
      return 'unknown';
    }

    // Compare content (exact match)
    if (localContent.trim() === cloudContent.trim()) {
      return 'synced';
    }

    // Content differs - determine who is ahead
    const cloudPublishedAt = new Date(cloudWorkflow.versions[0].publishedAt).getTime();

    // Local modified after cloud publish -> local has unpublished changes
    if (localModifiedAt > cloudPublishedAt) {
      return 'ahead';
    }

    // Cloud published after local modify -> cloud has newer version
    return 'behind';
  } catch (error: any) {
    console.error(`Error determining sync status: ${error.message}`);
    return 'unknown';
  }
}

// ============================================================================
// Cached Status Retrieval
// ============================================================================

/**
 * Gets the sync status for a workflow, using cache when possible.
 *
 * This function first checks the cache for a valid status. If not found
 * or expired, it determines the status fresh and updates the cache.
 *
 * @param workflowName - The name of the workflow
 * @param localContent - The current local file content
 * @param localModifiedAt - Local file modification time (Unix timestamp)
 * @returns Promise resolving to WorkflowSyncStatus with complete metadata
 *
 * @example
 * ```typescript
 * const fileUri = vscode.Uri.file('.generacy/my-workflow.yaml');
 * const stat = await vscode.workspace.fs.stat(fileUri);
 * const content = await vscode.workspace.fs.readFile(fileUri);
 *
 * const syncStatus = await getCachedSyncStatus(
 *   'my-workflow',
 *   Buffer.from(content).toString('utf8'),
 *   stat.mtime
 * );
 *
 * console.log(`Status: ${syncStatus.status}`);
 * ```
 */
export async function getCachedSyncStatus(
  workflowName: string,
  localContent: string,
  localModifiedAt: number
): Promise<WorkflowSyncStatus> {
  // Check cache first
  const cached = syncStatusCache.get(workflowName);
  if (cached) {
    return cached;
  }

  // Determine fresh status
  const status = await determineSyncStatus(workflowName, localContent, localModifiedAt);

  // Fetch cloud metadata for cache (if published)
  let cloudVersion: number | undefined;
  let cloudPublishedAt: string | undefined;

  if (status !== 'not-published' && status !== 'unknown') {
    try {
      const cloudWorkflow = await getPublishedWorkflow(workflowName);
      cloudVersion = cloudWorkflow.currentVersion;
      cloudPublishedAt = cloudWorkflow.versions[0].publishedAt;
    } catch {
      // Ignore errors, cloud metadata is optional
    }
  }

  // Update cache
  syncStatusCache.set(workflowName, status, cloudVersion, cloudPublishedAt);

  // Return complete status object
  const syncStatus: WorkflowSyncStatus = {
    name: workflowName,
    status,
    localModifiedAt,
    cloudVersion,
    cloudPublishedAt,
    cachedAt: Date.now(),
  };

  return syncStatus;
}

// ============================================================================
// Status Description Helpers
// ============================================================================

/**
 * Gets a human-readable tooltip description for a sync status.
 *
 * @param status - The sync status to describe
 * @returns Human-readable description suitable for tooltips
 */
export function getStatusTooltip(status: SyncStatus): string {
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
