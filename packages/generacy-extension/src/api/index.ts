/**
 * API module exports for Generacy extension.
 * Provides HTTP client, authentication, and type definitions for the Generacy cloud API.
 */

// Authentication
export {
  AuthService,
  getAuthService,
  AuthTier,
  type AuthUser,
  type AuthToken,
  type AuthState as AuthServiceState,
  type AuthChangeEvent,
} from './auth';

// Client
export { ApiClient, getApiClient } from './client';
export type { RequestInterceptor, ResponseInterceptor } from './client';

// Endpoints
export { userApi, getUserApi } from './endpoints/user';
export type { UserProfile } from './endpoints/user';
export { UserProfileSchema } from './endpoints/user';

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
  UserOrg,
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
  UserOrgSchema,
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
