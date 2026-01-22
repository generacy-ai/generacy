/**
 * API module exports for Generacy extension.
 * Provides HTTP client and type definitions for the Generacy cloud API.
 */

// Client
export { ApiClient, getApiClient } from './client';
export type { RequestInterceptor, ResponseInterceptor } from './client';

// Types
export type {
  // Common
  HttpMethod,
  ApiRequestOptions,
  ApiResponse,
  ApiErrorResponse,
  // Auth
  AuthState,
  AuthTokens,
  OAuthCallbackResponse,
  // User
  User,
  // Organization
  OrgTier,
  OrgRole,
  Organization,
  OrgMember,
  OrgUsage,
  // Queue
  QueueStatus,
  QueuePriority,
  QueueItem,
  QueueListResponse,
  // Integrations
  IntegrationType,
  IntegrationStatus,
  Integration,
  // Workflows
  WorkflowVersion,
  PublishedWorkflow,
  PublishWorkflowRequest,
  // Generic
  PaginatedResponse,
  SuccessResponse,
} from './types';

// Schemas
export {
  // Auth
  AuthTokensSchema,
  OAuthCallbackResponseSchema,
  // User
  UserSchema,
  // Organization
  OrganizationSchema,
  OrgMemberSchema,
  OrgUsageSchema,
  // Queue
  QueueItemSchema,
  QueueListResponseSchema,
  // Integrations
  IntegrationSchema,
  // Workflows
  WorkflowVersionSchema,
  PublishedWorkflowSchema,
  PublishWorkflowRequestSchema,
  // Generic
  createPaginatedSchema,
  SuccessResponseSchema,
} from './types';
