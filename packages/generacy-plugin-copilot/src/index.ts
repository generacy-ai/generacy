/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * GitHub Copilot Workspace agent platform plugin for Generacy.
 * Provides tracking and monitoring of Copilot Workspace sessions.
 */

// Core types
export type {
  // Workspace types
  Workspace,
  WorkspaceStatus,
  WorkspaceStatusEvent,
  // Input types
  CreateWorkspaceParams,
  WorkspaceOptions,
  // Output types
  FileChange,
  PullRequest,
  // Configuration types
  PollingConfig,
  CopilotPluginOptions,
  // Error types
  ErrorCode,
  PluginErrorData,
  // Plugin interface
  CopilotPluginInterface,
} from './types.js';

// Type guards
export { isTerminalStatus, isActiveStatus } from './types.js';

// Validation schemas
export {
  WorkspaceStatusSchema,
  FileChangeTypeSchema,
  PullRequestStateSchema,
  ReviewStatusSchema,
  WorkspaceOptionsSchema,
  CreateWorkspaceParamsSchema,
  PollingConfigSchema,
  GitHubTokenSchema,
  CopilotPluginOptionsSchema,
  FileChangeSchema,
  PullRequestSchema,
  WorkspaceSchema,
  WorkspaceStatusEventSchema,
} from './schemas.js';

// Error classes
export {
  PluginError,
  WorkspaceNotFoundError,
  WorkspaceInvalidStateError,
  GitHubAPIError,
  PollingTimeoutError,
  NotImplementedError,
  isPluginError,
  wrapError,
} from './errors.js';

// Main plugin class
export { CopilotPlugin } from './plugin/copilot-plugin.js';

// GitHub utilities
export { GitHubClient, parseIssueUrl } from './github/client.js';
export type {
  GitHubClientConfig,
  GitHubIssue,
  GitHubPullRequest,
  GitHubPRFile,
  GitHubReview,
  ParsedIssueUrl,
} from './github/types.js';

// Polling utilities
export { StatusPoller, createStatusPoller } from './polling/status-poller.js';
export { DEFAULT_POLLING_CONFIG } from './polling/types.js';
export type { PollState, PollResult, StatusChecker, StatusCallback } from './polling/types.js';

// Workspace utilities
export { WorkspaceManager } from './workspace/workspace-manager.js';
export type {
  InternalWorkspace,
  StatusInference,
  WorkspaceStore,
} from './workspace/types.js';
