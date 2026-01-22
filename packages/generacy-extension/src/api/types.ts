/**
 * API type definitions and Zod schemas for Generacy API client.
 * Provides type-safe API communication with runtime validation.
 */
import { z } from 'zod';

// ============================================================================
// Common Types
// ============================================================================

/**
 * HTTP methods supported by the API client
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * API request options
 */
export interface ApiRequestOptions {
  /** HTTP method (default: GET) */
  method?: HttpMethod;
  /** Request body (will be JSON serialized) */
  body?: unknown;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Query parameters */
  params?: Record<string, string | number | boolean | undefined>;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Skip authentication header (for public endpoints) */
  skipAuth?: boolean;
  /** Number of retries on failure (default: 3) */
  retries?: number;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  /** Response data */
  data: T;
  /** HTTP status code */
  status: number;
  /** Response headers */
  headers: Headers;
}

/**
 * API error response from server
 */
export interface ApiErrorResponse {
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
  /** Additional error details */
  details?: Record<string, unknown>;
}

// ============================================================================
// Authentication Types
// ============================================================================

/**
 * Authentication state
 */
export type AuthState = 'anonymous' | 'authenticated' | 'expired';

/**
 * Authentication tokens
 */
export interface AuthTokens {
  /** Access token for API requests */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken?: string;
  /** Token expiration time (Unix timestamp in seconds) */
  expiresAt: number;
}

/**
 * Zod schema for auth tokens
 */
export const AuthTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
});

/**
 * OAuth callback response
 */
export interface OAuthCallbackResponse {
  /** Access token */
  access_token: string;
  /** Refresh token */
  refresh_token?: string;
  /** Token type (usually "Bearer") */
  token_type: string;
  /** Expires in seconds */
  expires_in: number;
}

/**
 * Zod schema for OAuth callback response
 */
export const OAuthCallbackResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  token_type: z.string(),
  expires_in: z.number(),
});

// ============================================================================
// User Types
// ============================================================================

/**
 * User profile
 */
export interface User {
  /** Unique user ID */
  id: string;
  /** User email */
  email: string;
  /** Display name */
  name: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** GitHub username */
  githubUsername?: string;
  /** Account creation date */
  createdAt: string;
}

/**
 * Zod schema for user
 */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string(),
  avatarUrl: z.string().url().optional(),
  githubUsername: z.string().optional(),
  createdAt: z.string().datetime(),
});

// ============================================================================
// Organization Types
// ============================================================================

/**
 * Organization tier
 */
export type OrgTier = 'starter' | 'team' | 'enterprise';

/**
 * Organization member role
 */
export type OrgRole = 'owner' | 'admin' | 'member';

/**
 * Organization details
 */
export interface Organization {
  /** Unique organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** Organization slug (URL-safe identifier) */
  slug: string;
  /** Subscription tier */
  tier: OrgTier;
  /** Number of seats */
  seats: number;
  /** Max concurrent agents */
  maxConcurrentAgents: number;
  /** Creation date */
  createdAt: string;
}

/**
 * Zod schema for organization
 */
export const OrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  tier: z.enum(['starter', 'team', 'enterprise']),
  seats: z.number().int().positive(),
  maxConcurrentAgents: z.number().int().positive(),
  createdAt: z.string().datetime(),
});

/**
 * Organization member
 */
export interface OrgMember {
  /** User ID */
  userId: string;
  /** User details */
  user: User;
  /** Role in organization */
  role: OrgRole;
  /** Join date */
  joinedAt: string;
}

/**
 * Zod schema for organization member
 */
export const OrgMemberSchema = z.object({
  userId: z.string(),
  user: UserSchema,
  role: z.enum(['owner', 'admin', 'member']),
  joinedAt: z.string().datetime(),
});

/**
 * Organization usage metrics
 */
export interface OrgUsage {
  /** Billing period start */
  periodStart: string;
  /** Billing period end */
  periodEnd: string;
  /** Agent hours used */
  agentHoursUsed: number;
  /** Agent hours limit */
  agentHoursLimit: number;
  /** Current concurrent agents */
  currentConcurrentAgents: number;
}

/**
 * Zod schema for organization usage
 */
export const OrgUsageSchema = z.object({
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  agentHoursUsed: z.number().nonnegative(),
  agentHoursLimit: z.number().positive(),
  currentConcurrentAgents: z.number().int().nonnegative(),
});

// ============================================================================
// Workflow Queue Types
// ============================================================================

/**
 * Queue item status
 */
export type QueueStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Queue item priority
 */
export type QueuePriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Workflow queue item
 */
export interface QueueItem {
  /** Unique queue item ID */
  id: string;
  /** Workflow ID */
  workflowId: string;
  /** Workflow name */
  workflowName: string;
  /** Current status */
  status: QueueStatus;
  /** Priority level */
  priority: QueuePriority;
  /** Repository (owner/repo) */
  repository?: string;
  /** Assigned user ID */
  assigneeId?: string;
  /** Queue time */
  queuedAt: string;
  /** Start time */
  startedAt?: string;
  /** Completion time */
  completedAt?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Zod schema for queue item
 */
export const QueueItemSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  repository: z.string().optional(),
  assigneeId: z.string().optional(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
});

/**
 * Queue list response
 */
export interface QueueListResponse {
  /** Queue items */
  items: QueueItem[];
  /** Total count */
  total: number;
  /** Current page */
  page: number;
  /** Items per page */
  pageSize: number;
}

/**
 * Zod schema for queue list response
 */
export const QueueListResponseSchema = z.object({
  items: z.array(QueueItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

// ============================================================================
// Integration Types
// ============================================================================

/**
 * Integration type
 */
export type IntegrationType = 'github' | 'gitlab' | 'bitbucket' | 'jira' | 'linear';

/**
 * Integration status
 */
export type IntegrationStatus = 'connected' | 'disconnected' | 'error';

/**
 * Integration details
 */
export interface Integration {
  /** Integration type */
  type: IntegrationType;
  /** Current status */
  status: IntegrationStatus;
  /** Connection date */
  connectedAt?: string;
  /** Account/org name for the integration */
  accountName?: string;
  /** Error message if status is error */
  error?: string;
}

/**
 * Zod schema for integration
 */
export const IntegrationSchema = z.object({
  type: z.enum(['github', 'gitlab', 'bitbucket', 'jira', 'linear']),
  status: z.enum(['connected', 'disconnected', 'error']),
  connectedAt: z.string().datetime().optional(),
  accountName: z.string().optional(),
  error: z.string().optional(),
});

// ============================================================================
// Workflow Publishing Types
// ============================================================================

/**
 * Workflow version
 */
export interface WorkflowVersion {
  /** Version number */
  version: number;
  /** Version tag (e.g., "v1.0.0") */
  tag?: string;
  /** Publish date */
  publishedAt: string;
  /** Publisher user ID */
  publishedBy: string;
  /** Changelog/commit message */
  changelog?: string;
}

/**
 * Zod schema for workflow version
 */
export const WorkflowVersionSchema = z.object({
  version: z.number().int().positive(),
  tag: z.string().optional(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string(),
  changelog: z.string().optional(),
});

/**
 * Published workflow
 */
export interface PublishedWorkflow {
  /** Workflow ID */
  id: string;
  /** Workflow name */
  name: string;
  /** Current version */
  currentVersion: number;
  /** Version history */
  versions: WorkflowVersion[];
  /** Last sync time */
  lastSyncedAt?: string;
}

/**
 * Zod schema for published workflow
 */
export const PublishedWorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  currentVersion: z.number().int().positive(),
  versions: z.array(WorkflowVersionSchema),
  lastSyncedAt: z.string().datetime().optional(),
});

/**
 * Publish workflow request
 */
export interface PublishWorkflowRequest {
  /** Workflow name */
  name: string;
  /** Workflow YAML content */
  content: string;
  /** Changelog message */
  changelog?: string;
  /** Version tag */
  tag?: string;
}

/**
 * Zod schema for publish workflow request
 */
export const PublishWorkflowRequestSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  changelog: z.string().optional(),
  tag: z.string().optional(),
});

// ============================================================================
// Generic API Response Types
// ============================================================================

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  /** Response items */
  items: T[];
  /** Total count */
  total: number;
  /** Current page (1-indexed) */
  page: number;
  /** Items per page */
  pageSize: number;
  /** Has more pages */
  hasMore: boolean;
}

/**
 * Create a paginated response schema for a given item schema
 */
export function createPaginatedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    hasMore: z.boolean(),
  });
}

/**
 * Success response wrapper
 */
export interface SuccessResponse {
  /** Success indicator */
  success: true;
  /** Optional message */
  message?: string;
}

/**
 * Zod schema for success response
 */
export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
});
