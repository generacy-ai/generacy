/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Core type definitions for Copilot Workspace integration.
 */

import type { Logger } from 'pino';

// =============================================================================
// Workspace Types
// =============================================================================

/**
 * Workspace lifecycle states.
 */
export type WorkspaceStatus =
  | 'pending'
  | 'planning'
  | 'implementing'
  | 'review_ready'
  | 'merged'
  | 'failed'
  | 'not_available';

/**
 * Represents a Copilot Workspace instance.
 */
export interface Workspace {
  readonly id: string;
  readonly issueUrl: string;
  readonly status: WorkspaceStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly pullRequestUrl?: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

/**
 * Status update event for streaming.
 */
export interface WorkspaceStatusEvent {
  workspaceId: string;
  previousStatus: WorkspaceStatus;
  status: WorkspaceStatus;
  timestamp: Date;
  details?: {
    pullRequestUrl?: string;
    failureReason?: string;
    progress?: number;
  };
}

// =============================================================================
// Input Types
// =============================================================================

/**
 * Parameters for workspace creation.
 */
export interface CreateWorkspaceParams {
  issueUrl: string;
  options?: WorkspaceOptions;
}

/**
 * Options for workspace behavior.
 */
export interface WorkspaceOptions {
  autoMerge?: boolean;
  reviewRequired?: boolean;
  timeoutMs?: number;
  prLabels?: string[];
}

// =============================================================================
// Output Types
// =============================================================================

/**
 * A file change produced by Copilot Workspace.
 */
export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'deleted' | 'renamed';
  previousPath?: string;
  additions: number;
  deletions: number;
  content?: string;
  patch?: string;
}

/**
 * Pull request created by Copilot Workspace.
 */
export interface PullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  head: string;
  base: string;
  mergeable?: boolean;
  linkedIssues: number[];
  reviewStatus: 'pending' | 'approved' | 'changes_requested' | 'dismissed';
  changedFiles: number;
  additions: number;
  deletions: number;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Polling behavior configuration.
 */
export interface PollingConfig {
  initialIntervalMs: number;
  maxIntervalMs: number;
  backoffMultiplier: number;
  maxRetries: number;
  timeoutMs?: number;
}

/**
 * Configuration options for CopilotPlugin.
 */
export interface CopilotPluginOptions {
  githubToken: string;
  apiBaseUrl?: string;
  logger?: Logger;
  polling?: Partial<PollingConfig>;
  workspaceDefaults?: WorkspaceOptions;
}

// =============================================================================
// Error Types
// =============================================================================

/**
 * Error classification codes.
 */
export type ErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_INVALID_STATE'
  | 'GITHUB_API_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'POLLING_TIMEOUT'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';

/**
 * Error data structure for plugin errors.
 */
export interface PluginErrorData {
  code: ErrorCode;
  isTransient: boolean;
  message: string;
  context?: Record<string, unknown>;
}

// =============================================================================
// Plugin Interface
// =============================================================================

/**
 * Main plugin interface for Copilot Workspace integration.
 */
export interface CopilotPluginInterface {
  /**
   * Create a new workspace for tracking.
   */
  createWorkspace(params: CreateWorkspaceParams): Promise<Workspace>;

  /**
   * Get an existing workspace by ID.
   */
  getWorkspace(workspaceId: string): Promise<Workspace | null>;

  /**
   * Poll the current status of a workspace.
   */
  pollWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus>;

  /**
   * Get file changes from a completed workspace.
   */
  getChanges(workspaceId: string): Promise<FileChange[]>;

  /**
   * Get the pull request associated with the workspace.
   */
  getPullRequest(workspaceId: string): Promise<PullRequest | null>;

  /**
   * Stream status updates from a workspace.
   */
  streamStatus(workspaceId: string): AsyncIterable<WorkspaceStatusEvent>;

  /**
   * Dispose of the plugin and cleanup resources.
   */
  dispose(): Promise<void>;
}

// =============================================================================
// Type Guards
// =============================================================================

/**
 * Type guard for terminal workspace statuses.
 */
export function isTerminalStatus(status: WorkspaceStatus): boolean {
  return ['merged', 'failed', 'not_available'].includes(status);
}

/**
 * Type guard for active workspace statuses.
 */
export function isActiveStatus(status: WorkspaceStatus): boolean {
  return ['pending', 'planning', 'implementing', 'review_ready'].includes(status);
}
