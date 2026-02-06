// Main plugin export
export { JiraPlugin, createPlugin } from './plugin.js';

// Client exports
export { JiraClient, createClient, createClientAsync } from './client.js';

// Type exports
export type {
  // Configuration
  JiraConfig,
  ValidatedJiraConfig,

  // Issues
  JiraUser,
  IssueType,
  Priority,
  IssueRef,
  Component,
  IssueLink,
  JiraIssue,
  CreateJiraIssueParams,
  UpdateJiraIssueParams,
  SearchOptions,

  // Projects
  ProjectRef,
  Project,
  Board,

  // Sprints
  SprintState,
  Sprint,
  AddToSprintParams,

  // Workflows
  StatusCategory,
  JiraStatus,
  FieldSchema,
  TransitionField,
  Transition,
  TransitionParams,

  // Custom Fields
  CustomFieldType,
  CustomField,
  CustomFieldOption,
  CustomFieldContext,
  SetCustomFieldParams,

  // ADF and Comments
  AdfMark,
  AdfTextNode,
  AdfHardBreak,
  AdfMention,
  AdfEmoji,
  AdfInlineCard,
  AdfInlineNode,
  AdfParagraph,
  AdfHeading,
  AdfCodeBlock,
  AdfListItem,
  AdfBulletList,
  AdfOrderedList,
  AdfTableCell,
  AdfTableRow,
  AdfTable,
  AdfPanel,
  AdfBlockquote,
  AdfRule,
  AdfMediaSingle,
  AdfMedia,
  AdfNode,
  AdfDocument,
  JiraComment,
  CommentVisibility,
  AddCommentParams,
} from './types/index.js';

// Schema exports
export {
  JiraConfigSchema,
  IssueTypeMappingSchema,
  WorkflowMappingSchema,
} from './types/index.js';

// Error exports
export {
  JiraPluginError,
  JiraAuthError,
  JiraRateLimitError,
  JiraNotFoundError,
  JiraValidationError,
  JiraTransitionError,
  JiraConnectionError,
  isJiraApiError,
  wrapJiraError,
} from './utils/errors.js';

// Validation exports
export {
  validateConfig,
  validateIssueKey,
  validateProjectKey,
  validateJql,
  validateDateString,
  ensureIssueKey,
  ensureProjectKey,
} from './utils/validation.js';

// ADF utilities
export {
  isAdfDocument,
  textToAdf,
  adfToText,
  ensureAdf,
  createAdfParagraph,
  createSimpleAdf,
} from './utils/adf.js';

// JQL builder
export { JqlBuilder, jql } from './utils/jql-builder.js';

// Operations exports (for advanced usage)
export { IssueOperations, createIssueOperations } from './operations/issues.js';
export { SearchOperations, createSearchOperations } from './operations/search.js';
export { CommentOperations, createCommentOperations } from './operations/comments.js';
export { TransitionOperations, createTransitionOperations } from './operations/transitions.js';
export { CustomFieldOperations, createCustomFieldOperations } from './operations/custom-fields.js';
export { SprintOperations, createSprintOperations } from './operations/sprints.js';

// Webhook exports
export {
  JiraWebhookHandler,
  createWebhookHandler,
  type JiraWebhookHandlerConfig,
  type WebhookProcessResult,
} from './webhooks/handler.js';

export type {
  JiraEventType,
  ChangelogItem,
  Changelog,
  JiraWebhookEventBase,
  JiraIssueEvent,
  JiraCommentEvent,
  JiraSprintEvent,
  JiraWebhookEvent,
  WebhookActionType,
  WebhookAction,
  WebhookHandler,
  WebhookHandlerRegistration,
} from './webhooks/types.js';

export {
  parseWebhookPayload,
  parseWebhookAction,
  extractChanges,
  hasFieldChange,
  getFieldChange,
  isEventForIssue,
  isEventByUser,
  getIssueKeyFromEvent,
} from './webhooks/parser.js';

export {
  verifySignature,
  verifySourceIp,
  verifyWebhook,
  createVerificationMiddleware,
  ATLASSIAN_IP_RANGES,
  type VerificationResult,
  type VerifyOptions,
} from './webhooks/verify.js';
