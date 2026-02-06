/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Plugin interface contract defining the public API.
 * This file serves as the contract for implementations.
 */

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
// Plugin Interface
// =============================================================================

/**
 * Main plugin interface for Copilot Workspace integration.
 */
export interface CopilotPluginInterface {
  /**
   * Create a new workspace for tracking.
   * Note: This does not create the Copilot Workspace itself (no API available),
   * but sets up tracking for when a workspace is manually created.
   */
  createWorkspace(params: CreateWorkspaceParams): Promise<Workspace>;

  /**
   * Get an existing workspace by ID.
   * Returns null if workspace not found.
   */
  getWorkspace(workspaceId: string): Promise<Workspace | null>;

  /**
   * Poll the current status of a workspace.
   * Uses GitHub API to infer status from PR state.
   */
  pollWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatus>;

  /**
   * Get file changes from a completed workspace.
   * Only available when status is 'review_ready' or 'merged'.
   */
  getChanges(workspaceId: string): Promise<FileChange[]>;

  /**
   * Get the pull request associated with the workspace.
   * Returns null if no PR has been created yet.
   */
  getPullRequest(workspaceId: string): Promise<PullRequest | null>;

  /**
   * Stream status updates from a workspace.
   * Yields events as status changes are detected.
   */
  streamStatus(workspaceId: string): AsyncIterable<WorkspaceStatusEvent>;

  /**
   * Dispose of the plugin and cleanup resources.
   * After calling dispose, no other methods should be called.
   */
  dispose(): Promise<void>;
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
  logger?: unknown; // Logger instance or options
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
