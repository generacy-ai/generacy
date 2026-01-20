// Main plugin export
export { GitHubIssuesPlugin, createPlugin } from './plugin.js';

// Client export
export { GitHubClient, createClient } from './client.js';

// Operations exports
export { IssueOperations, createIssueOperations } from './operations/issues.js';
export { LabelOperations, createLabelOperations } from './operations/labels.js';
export { CommentOperations, createCommentOperations } from './operations/comments.js';
export { PullRequestOperations, createPullRequestOperations } from './operations/pull-requests.js';

// Webhook exports
export {
  WebhookHandler,
  createWebhookHandler,
  parseWebhookEvent,
  isSupportedEvent,
  evaluateTriggers,
  requiresProcessing,
  getActionIssueNumber,
} from './webhooks/handler.js';

export type {
  WebhookHandlerConfig,
  WebhookHeaders,
  WebhookResult,
  TriggerConfig,
} from './webhooks/handler.js';

// Type exports
export type {
  // Configuration
  GitHubIssuesConfig,
  ValidatedConfig,

  // Issues
  User,
  Label,
  Comment,
  Milestone,
  Issue,
  PullRequest,
  CreateIssueParams,
  UpdateIssueParams,
  IssueFilter,

  // Events
  Repository,
  WebhookEvent,
  IssuesEventPayload,
  IssueCommentEventPayload,
  PullRequestEventPayload,
  WebhookEventName,
  TypedWebhookEvent,

  // Responses
  QueueForProcessingAction,
  StartWorkflowAction,
  ResumeWorkflowAction,
  NoAction,
  WorkflowAction,
  OperationResult,
  OperationError,
  OperationResponse,
} from './types/index.js';

// Schema exports
export {
  GitHubIssuesConfigSchema,
  CreateIssueParamsSchema,
  UpdateIssueParamsSchema,
  IssueFilterSchema,
} from './types/index.js';

// Error exports
export {
  GitHubIssuesError,
  GitHubAuthError,
  GitHubRateLimitError,
  GitHubNotFoundError,
  GitHubValidationError,
  WebhookVerificationError,
  wrapGitHubError,
} from './utils/errors.js';

// Validation exports
export {
  validate,
  validateConfig,
  validateCreateIssueParams,
  validateUpdateIssueParams,
  validateIssueFilter,
  isNonEmptyString,
  isPositiveInteger,
} from './utils/validation.js';
