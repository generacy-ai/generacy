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
 * User's organization membership (lightweight, embedded in User)
 */
export interface UserOrg {
  /** Organization ID */
  id: string;
  /** Organization name */
  name: string;
  /** User's role in the organization */
  role: 'owner' | 'admin' | 'member';
}

/**
 * Zod schema for user organization membership
 */
export const UserOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
});

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
  /** Organization memberships (populated from /users/me) */
  organizations?: UserOrg[];
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
  organizations: z.array(UserOrgSchema).optional(),
});

// ============================================================================
// Organization Types
// ============================================================================

/**
 * Organization tier
 */
export type OrgTier = 'free' | 'basic' | 'standard' | 'professional' | 'enterprise';

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
  tier: z.enum(['free', 'basic', 'standard', 'professional', 'enterprise']),
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
  /** Current active execution slots (from lease system) */
  activeExecutions?: number;
  /** Current connected cluster count */
  connectedClusters?: number;
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
  activeExecutions: z.number().int().nonnegative().optional(),
  connectedClusters: z.number().int().nonnegative().optional(),
});

// ============================================================================
// Workflow Queue Types
// ============================================================================

/**
 * Queue item status
 */
export type QueueStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

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
  /** Description of what the job is waiting for (present when status is 'waiting') */
  waitingFor?: string;
  /** Lightweight progress summary (present for running/completed items) */
  progress?: QueueItemProgressSummary;
  /** Labels/tags associated with the job */
  labels?: string[];
}

/**
 * Zod schema for queue item
 */
export const QueueItemSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  repository: z.string().optional(),
  assigneeId: z.string().optional(),
  queuedAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  error: z.string().optional(),
  waitingFor: z.string().optional(),
  progress: z.lazy(() => QueueItemProgressSummarySchema).optional(),
  labels: z.array(z.string()).optional(),
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
// Job Progress Types
// ============================================================================

/**
 * Execution status of a workflow phase
 */
export type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Execution status of a workflow step within a phase
 */
export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Progress detail for a single step within a phase
 */
export interface StepProgress {
  /** Step identifier (e.g., "T001") */
  id: string;
  /** Step display name */
  name: string;
  /** Current status */
  status: StepStatus;
  /** Start timestamp (ISO datetime) */
  startedAt?: string;
  /** Completion timestamp (ISO datetime) */
  completedAt?: string;
  /** Duration in milliseconds (set on completion) */
  durationMs?: number;
  /** Single-line summary output (e.g., "Generated 3 files") */
  output?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Progress detail for a workflow phase containing steps
 */
export interface PhaseProgress {
  /** Phase identifier (e.g., "setup", "implementation") */
  id: string;
  /** Phase display name */
  name: string;
  /** Current status */
  status: PhaseStatus;
  /** Start timestamp (ISO datetime) */
  startedAt?: string;
  /** Completion timestamp (ISO datetime) */
  completedAt?: string;
  /** Duration in milliseconds (set on completion) */
  durationMs?: number;
  /** Steps within this phase */
  steps: StepProgress[];
  /** Error message if phase failed */
  error?: string;
}

/**
 * Full progress snapshot for a job, returned by GET /queue/:id/progress
 * and sent in workflow:progress SSE snapshot events
 */
export interface JobProgress {
  /** Queue item / job ID */
  jobId: string;
  /** Current phase index (0-based) */
  currentPhaseIndex: number;
  /** Total number of phases */
  totalPhases: number;
  /** Number of completed phases */
  completedPhases: number;
  /** Number of skipped phases */
  skippedPhases: number;
  /** All phases with their step-level detail */
  phases: PhaseProgress[];
  /** PR URL when pr-creation phase completes */
  pullRequestUrl?: string;
  /** Last updated timestamp */
  updatedAt: string;
}

/**
 * Lightweight progress summary for tree view display.
 * Avoids fetching full progress for every item in the queue list.
 */
export interface QueueItemProgressSummary {
  /** Current phase name (e.g., "implementation") */
  currentPhase?: string;
  /** Progress string for display (e.g., "Phase 5/8") */
  phaseProgress?: string;
  /** Total phases count */
  totalPhases?: number;
  /** Completed phases count */
  completedPhases?: number;
  /** Skipped phases count */
  skippedPhases?: number;
}

/**
 * Zod schema for step status
 */
export const StepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

/**
 * Zod schema for phase status
 */
export const PhaseStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

/**
 * Zod schema for step progress
 */
export const StepProgressSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: StepStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Zod schema for phase progress
 */
export const PhaseProgressSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: PhaseStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  steps: z.array(StepProgressSchema),
  error: z.string().optional(),
});

/**
 * Zod schema for job progress
 */
export const JobProgressSchema = z.object({
  jobId: z.string(),
  currentPhaseIndex: z.number().int().nonnegative(),
  totalPhases: z.number().int().nonnegative(),
  completedPhases: z.number().int().nonnegative(),
  skippedPhases: z.number().int().nonnegative(),
  phases: z.array(PhaseProgressSchema),
  pullRequestUrl: z.string().url().optional(),
  updatedAt: z.string().datetime(),
});

/**
 * Zod schema for queue item progress summary
 */
export const QueueItemProgressSummarySchema = z.object({
  currentPhase: z.string().optional(),
  phaseProgress: z.string().optional(),
  totalPhases: z.number().int().nonnegative().optional(),
  completedPhases: z.number().int().nonnegative().optional(),
  skippedPhases: z.number().int().nonnegative().optional(),
});

// ============================================================================
// SSE Workflow Event Payloads
// ============================================================================

/**
 * Payload for workflow:phase:start and workflow:phase:complete SSE events
 */
export interface WorkflowPhaseEventData {
  /** Workflow ID */
  workflowId: string;
  /** Queue item / job ID */
  jobId: string;
  /** Full phase progress snapshot */
  phase: PhaseProgress;
  /** 0-based index of the phase */
  phaseIndex: number;
  /** Total number of phases in the workflow */
  totalPhases: number;
}

/**
 * Payload for workflow:step:start and workflow:step:complete SSE events
 */
export interface WorkflowStepEventData {
  /** Workflow ID */
  workflowId: string;
  /** Queue item / job ID */
  jobId: string;
  /** Phase ID containing this step */
  phaseId: string;
  /** 0-based index of the phase */
  phaseIndex: number;
  /** Full step progress snapshot */
  step: StepProgress;
  /** 0-based index of the step within its phase */
  stepIndex: number;
  /** Total number of steps in the phase */
  totalSteps: number;
}

// ============================================================================
// Job Detail Webview Message Types
// ============================================================================

/**
 * Messages sent from the JobDetailPanel webview to the extension host.
 */
export type JobDetailWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'pin' }
  | { type: 'togglePhase'; phaseId: string }
  | { type: 'openPR'; url: string }
  | { type: 'openAgent'; agentId: string }
  | { type: 'viewLogs' };

/**
 * Messages sent from the extension host to the JobDetailPanel webview.
 */
export type JobDetailExtensionMessage =
  | { type: 'update'; data: { item: QueueItem; progress: JobProgress | null; expandedPhases?: string[] } }
  | { type: 'progressUpdate'; progress: JobProgress; expandedPhases?: string[] }
  | { type: 'phaseEvent'; event: WorkflowPhaseEventData }
  | { type: 'stepEvent'; event: WorkflowStepEventData }
  | { type: 'connectionStatus'; connected: boolean; reconnecting?: boolean }
  | { type: 'error'; message: string };

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
// Agent Types
// ============================================================================

/**
 * Agent connection status (mirrors orchestrator's AgentConnectionStatus)
 */
export type AgentConnectionStatus = 'connected' | 'idle' | 'busy' | 'disconnected';

/**
 * Agent type (mirrors orchestrator's AgentType)
 */
export type AgentType = 'claude' | 'gpt4' | 'custom';

/**
 * Display status for UI grouping in the agent tree view
 */
export type AgentDisplayStatus = 'available' | 'busy' | 'offline';

/**
 * Agent details (mirrors orchestrator's ConnectedAgent)
 */
export interface Agent {
  /** Unique agent ID */
  id: string;
  /** Agent display name */
  name: string;
  /** Agent type */
  type: AgentType;
  /** Connection status */
  status: AgentConnectionStatus;
  /** Agent capabilities */
  capabilities: string[];
  /** Last seen timestamp (ISO datetime) */
  lastSeen: string;
  /** Agent metadata */
  metadata: {
    version?: string;
    platform?: string;
    workflowId?: string;
  };
}

/**
 * Zod schema for agent
 */
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['claude', 'gpt4', 'custom']),
  status: z.enum(['connected', 'idle', 'busy', 'disconnected']),
  capabilities: z.array(z.string()),
  lastSeen: z.string().datetime(),
  metadata: z.object({
    version: z.string().optional(),
    platform: z.string().optional(),
    workflowId: z.string().uuid().optional(),
  }),
});

/**
 * Agent list response
 */
export interface AgentListResponse {
  /** Agent items */
  items: Agent[];
  /** Total count */
  total: number;
  /** Current page */
  page: number;
  /** Items per page */
  pageSize: number;
}

/**
 * Zod schema for agent list response
 */
export const AgentListResponseSchema = z.object({
  items: z.array(AgentSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

/**
 * Agent pool statistics
 */
export interface AgentStats {
  /** Total agents */
  total: number;
  /** Available agents (connected or idle) */
  available: number;
  /** Busy agents */
  busy: number;
  /** Offline agents */
  offline: number;
}

/**
 * Zod schema for agent stats
 */
export const AgentStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  busy: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative(),
});

// ============================================================================
// Activity Types
// ============================================================================

/**
 * Activity event types for the dashboard feed
 */
export type ActivityEventType =
  | 'workflow:started'
  | 'workflow:completed'
  | 'workflow:failed'
  | 'workflow:cancelled'
  | 'agent:connected'
  | 'agent:disconnected'
  | 'queue:item:added'
  | 'queue:item:removed';

/**
 * Activity event for the dashboard activity feed
 */
export interface ActivityEvent {
  /** Unique event ID */
  id: string;
  /** Event type */
  type: ActivityEventType;
  /** Human-readable event message */
  message: string;
  /** Event timestamp (ISO datetime) */
  timestamp: string;
  /** Additional event metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Zod schema for activity event
 */
export const ActivityEventSchema = z.object({
  id: z.string(),
  type: z.enum([
    'workflow:started',
    'workflow:completed',
    'workflow:failed',
    'workflow:cancelled',
    'agent:connected',
    'agent:disconnected',
    'queue:item:added',
    'queue:item:removed',
  ]),
  message: z.string(),
  timestamp: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Activity list response
 */
export interface ActivityListResponse {
  /** Activity events */
  items: ActivityEvent[];
  /** Total count */
  total: number;
  /** Current page */
  page: number;
  /** Items per page */
  pageSize: number;
}

/**
 * Zod schema for activity list response
 */
export const ActivityListResponseSchema = z.object({
  items: z.array(ActivityEventSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

// ============================================================================
// Agent Log Types
// ============================================================================

/**
 * Single log line from an agent
 */
export interface AgentLogLine {
  /** Log line content */
  line: string;
  /** Log line timestamp (ISO datetime) */
  timestamp?: string;
}

/**
 * Zod schema for agent log line
 */
export const AgentLogLineSchema = z.object({
  line: z.string(),
  timestamp: z.string().datetime().optional(),
});

/**
 * Agent logs response
 */
export interface AgentLogsResponse {
  /** Log lines */
  lines: AgentLogLine[];
  /** Total number of log lines */
  total: number;
  /** Offset from start */
  offset: number;
  /** Number of lines requested */
  limit: number;
}

/**
 * Zod schema for agent logs response
 */
export const AgentLogsResponseSchema = z.object({
  lines: z.array(AgentLogLineSchema),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

// ============================================================================
// Job Log Types
// ============================================================================

/**
 * Single log line from a remote job's claude CLI output
 */
export interface JobLogLine {
  /** Log line text (pre-cleaned, no ANSI) */
  content: string;
  /** Which output stream this line came from */
  stream: 'stdout' | 'stderr';
  /** ISO timestamp */
  timestamp: string;
  /** Optional step context */
  stepName?: string;
}

/**
 * Zod schema for job log line
 */
export const JobLogLineSchema = z.object({
  content: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  timestamp: z.string().datetime(),
  stepName: z.string().optional(),
});

/**
 * Job logs response from GET /queue/:id/logs
 */
export interface JobLogsResponse {
  /** Array of log lines */
  lines: JobLogLine[];
  /** Total line count on server */
  total: number;
  /** Cursor for SSE handoff (zero-gap transition) */
  cursor?: string;
  /** Whether the result was truncated */
  truncated: boolean;
}

/**
 * Zod schema for job logs response
 */
export const JobLogsResponseSchema = z.object({
  lines: z.array(JobLogLineSchema),
  total: z.number().int().nonnegative(),
  cursor: z.string().optional(),
  truncated: z.boolean(),
});

// ============================================================================
// SSE Event Types
// ============================================================================

/**
 * SSE channel for subscription routing
 */
export type SSEChannel = 'workflows' | 'queue' | 'agents' | 'jobs';

/**
 * SSE event received from the orchestrator
 */
export interface SSEEvent<T = unknown> {
  /** Unique event ID (maps to SSE 'id:' field for Last-Event-ID) */
  id: string;
  /** Event type */
  event: string;
  /** Channel this event belongs to */
  channel: SSEChannel;
  /** Event payload */
  data: T;
  /** Event timestamp (ISO datetime) */
  timestamp: string;
}

/**
 * Zod schema for SSE event
 */
export const SSEEventSchema = z.object({
  id: z.string(),
  event: z.string(),
  channel: z.enum(['workflows', 'queue', 'agents', 'jobs']),
  data: z.unknown(),
  timestamp: z.string().datetime(),
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
