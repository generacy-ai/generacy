/**
 * Sync status types and utilities for workflow publishing.
 *
 * This module provides types and constants for tracking the synchronization
 * status between local workflow files and their cloud-published versions.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Represents the synchronization status of a local workflow file relative to the cloud.
 *
 * - `synced`: Local content matches cloud version (up to date)
 * - `ahead`: Local has unpublished changes (local is newer)
 * - `behind`: Cloud has a newer version than local
 * - `conflict`: Both local and cloud have been modified independently
 * - `not-published`: Workflow has never been published to cloud
 * - `unknown`: Unable to determine status (e.g., network error, missing data)
 */
export type SyncStatus =
  | 'synced'
  | 'ahead'
  | 'behind'
  | 'conflict'
  | 'not-published'
  | 'unknown';

/**
 * Tracks the synchronization status of a workflow file.
 *
 * This interface combines local file metadata with cloud version information
 * to provide a complete picture of sync state. The status is cached to avoid
 * excessive API calls.
 */
export interface WorkflowSyncStatus {
  /** Local workflow name (filename without extension) */
  name: string;

  /** Current synchronization status */
  status: SyncStatus;

  /** Local file modification time (Unix timestamp in milliseconds) */
  localModifiedAt: number;

  /**
   * Cloud version number (if published).
   * Undefined if workflow has never been published.
   */
  cloudVersion?: number;

  /**
   * Cloud version publish timestamp (if published).
   * ISO 8601 datetime string. Undefined if workflow has never been published.
   */
  cloudPublishedAt?: string;

  /**
   * Cache timestamp (Unix timestamp in milliseconds).
   * Indicates when this status was last computed.
   */
  cachedAt: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Icon characters for each sync status.
 *
 * Used in tree views and status bars to provide visual indicators.
 */
export const SYNC_STATUS_ICONS: Record<SyncStatus, string> = {
  'synced': '✓',
  'ahead': '↑',
  'behind': '↓',
  'conflict': '⚠',
  'not-published': '⊘',
  'unknown': '?',
};

/**
 * VS Code theme color names for each sync status.
 *
 * These are ThemeColor identifiers that adapt to the user's theme.
 * Used for colorizing status indicators in the UI.
 *
 * @see https://code.visualstudio.com/api/references/theme-color
 */
export const SYNC_STATUS_COLORS: Record<SyncStatus, string> = {
  'synced': 'charts.green',
  'ahead': 'charts.yellow',
  'behind': 'charts.blue',
  'conflict': 'errorForeground',
  'not-published': 'descriptionForeground',
  'unknown': 'descriptionForeground',
};
