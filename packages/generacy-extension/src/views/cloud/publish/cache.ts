/**
 * Sync status cache implementation for workflow publishing.
 *
 * This module provides a singleton cache to reduce API calls when checking
 * workflow sync status. The cache automatically expires entries after the TTL
 * period and provides methods for manual invalidation.
 */

import type { WorkflowSyncStatus, SyncStatus } from './types';
import { SYNC_STATUS_CACHE_TTL } from '../../../api/types/workflows';

/**
 * In-memory cache for workflow synchronization status.
 *
 * The cache stores sync status information with automatic expiration based on TTL.
 * Expired entries are treated as cache misses and return undefined.
 *
 * @example
 * ```typescript
 * // Check cache before making API call
 * const cached = syncStatusCache.get('my-workflow');
 * if (cached) {
 *   return cached;
 * }
 *
 * // Store fresh status in cache
 * const status = await fetchSyncStatus('my-workflow');
 * syncStatusCache.set('my-workflow', 'synced', 5, '2024-01-22T12:00:00Z');
 *
 * // Invalidate after publish
 * syncStatusCache.invalidate('my-workflow');
 * ```
 */
export class SyncStatusCache {
  /**
   * Internal cache storage mapping workflow names to their sync status.
   */
  private cache: Map<string, WorkflowSyncStatus> = new Map();

  /**
   * Cache time-to-live in milliseconds (5 minutes).
   * After this period, cached entries are considered stale.
   */
  private readonly TTL: number = SYNC_STATUS_CACHE_TTL;

  /**
   * Retrieves cached sync status for a workflow if it exists and is not expired.
   *
   * @param workflowName - The name of the workflow to look up
   * @returns The cached sync status if valid, undefined if expired or not found
   *
   * @example
   * ```typescript
   * const status = syncStatusCache.get('my-workflow');
   * if (status) {
   *   console.log(`Cached status: ${status.status}`);
   * } else {
   *   console.log('Cache miss - need to fetch fresh status');
   * }
   * ```
   */
  get(workflowName: string): WorkflowSyncStatus | undefined {
    const cached = this.cache.get(workflowName);

    if (!cached) {
      return undefined;
    }

    // Check if entry has expired
    const isExpired = Date.now() - cached.cachedAt > this.TTL;
    if (isExpired) {
      // Clean up expired entry
      this.cache.delete(workflowName);
      return undefined;
    }

    return cached;
  }

  /**
   * Stores sync status for a workflow in the cache.
   *
   * Creates a complete WorkflowSyncStatus object with the current timestamp
   * and optional cloud metadata.
   *
   * @param workflowName - The name of the workflow
   * @param status - The synchronization status
   * @param cloudVersion - Optional cloud version number
   * @param cloudPublishedAt - Optional cloud publish timestamp (ISO 8601)
   *
   * @example
   * ```typescript
   * // Cache status for unpublished workflow
   * syncStatusCache.set('new-workflow', 'not-published');
   *
   * // Cache status for published workflow
   * syncStatusCache.set('existing-workflow', 'synced', 3, '2024-01-22T12:00:00Z');
   * ```
   */
  set(
    workflowName: string,
    status: SyncStatus,
    cloudVersion?: number,
    cloudPublishedAt?: string
  ): void {
    const workflowStatus: WorkflowSyncStatus = {
      name: workflowName,
      status,
      localModifiedAt: Date.now(),
      cloudVersion,
      cloudPublishedAt,
      cachedAt: Date.now(),
    };

    this.cache.set(workflowName, workflowStatus);
  }

  /**
   * Removes a specific workflow's sync status from the cache.
   *
   * Use this when you know the cached status is stale, such as after
   * publishing, rolling back, or detecting local file changes.
   *
   * @param workflowName - The name of the workflow to invalidate
   *
   * @example
   * ```typescript
   * // Invalidate after publishing
   * await publishWorkflow('my-workflow', content);
   * syncStatusCache.invalidate('my-workflow');
   * ```
   */
  invalidate(workflowName: string): void {
    this.cache.delete(workflowName);
  }

  /**
   * Clears all cached sync status entries.
   *
   * Use this for operations that may affect multiple workflows,
   * such as authentication changes or manual refresh commands.
   *
   * @example
   * ```typescript
   * // Clear all cache on manual refresh
   * command.register('generacy.refreshSyncStatus', () => {
   *   syncStatusCache.invalidateAll();
   *   // Refresh UI
   * });
   * ```
   */
  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Singleton instance of the sync status cache.
 *
 * Use this shared instance throughout the extension to maintain
 * consistent cache state across all components.
 *
 * @example
 * ```typescript
 * import { syncStatusCache } from './cache';
 *
 * // In publish handler
 * await publishWorkflow(name, content);
 * syncStatusCache.invalidate(name);
 *
 * // In file watcher
 * onFileChange((file) => {
 *   syncStatusCache.invalidate(file.name);
 * });
 * ```
 */
export const syncStatusCache = new SyncStatusCache();
