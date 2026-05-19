import { z } from 'zod';

// ============================================================================
// Workflow Types
// ============================================================================

export const WorkflowStatusSchema = z.enum([
  'created',
  'running',
  'paused',
  'completed',
  'cancelled',
  'failed',
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const CreateWorkflowRequestSchema = z
  .object({
    definitionId: z.string().uuid().optional(),
    definition: z.record(z.unknown()).optional(),
    context: z.record(z.unknown()),
    metadata: z
      .object({
        name: z.string().max(255).optional(),
        tags: z.array(z.string().max(50)).max(10).optional(),
      })
      .optional(),
  })
  .refine((data) => data.definitionId || data.definition, {
    message: 'Either definitionId or definition must be provided',
  });
export type CreateWorkflowRequest = z.infer<typeof CreateWorkflowRequestSchema>;

export const WorkflowResponseSchema = z.object({
  id: z.string().uuid(),
  status: WorkflowStatusSchema,
  currentStep: z.string().nullable(),
  context: z.record(z.unknown()),
  metadata: z.object({
    name: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable().optional(),
});
export type WorkflowResponse = z.infer<typeof WorkflowResponseSchema>;

export const PaginationSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export const WorkflowListResponseSchema = z.object({
  workflows: z.array(WorkflowResponseSchema),
  pagination: PaginationSchema,
});
export type WorkflowListResponse = z.infer<typeof WorkflowListResponseSchema>;

export const ListWorkflowsQuerySchema = z.object({
  status: WorkflowStatusSchema.optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListWorkflowsQuery = z.infer<typeof ListWorkflowsQuerySchema>;

export const WorkflowIdParamSchema = z.object({
  id: z.string().uuid(),
});
export type WorkflowIdParam = z.infer<typeof WorkflowIdParamSchema>;

// ============================================================================
// Decision Queue Types
// ============================================================================

export const DecisionTypeSchema = z.enum(['approval', 'choice', 'input', 'review']);
export type DecisionType = z.infer<typeof DecisionTypeSchema>;

export const DecisionPrioritySchema = z.enum(['blocking_now', 'blocking_soon', 'when_available']);
export type DecisionPriority = z.infer<typeof DecisionPrioritySchema>;

export const DecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type DecisionOption = z.infer<typeof DecisionOptionSchema>;

export const DecisionQueueItemSchema = z.object({
  id: z.string().uuid(),
  workflowId: z.string().min(1),
  stepId: z.string(),
  type: DecisionTypeSchema,
  prompt: z.string(),
  options: z.array(DecisionOptionSchema).optional(),
  context: z.record(z.unknown()),
  priority: DecisionPrioritySchema,
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type DecisionQueueItem = z.infer<typeof DecisionQueueItemSchema>;

export const CreateDecisionRequestSchema = z.object({
  workflowId: z.string().min(1),
  stepId: z.string().min(1),
  type: DecisionTypeSchema,
  prompt: z.string().min(1),
  options: z.array(DecisionOptionSchema).optional(),
  context: z.record(z.unknown()).default({}),
  priority: DecisionPrioritySchema.default('when_available'),
  expiresAt: z.string().datetime().nullable().optional(),
  agentId: z.string().optional(),
});
export type CreateDecisionRequest = z.infer<typeof CreateDecisionRequestSchema>;

export const DecisionResponseRequestSchema = z.object({
  response: z.union([z.string(), z.boolean(), z.array(z.string())]),
  comment: z.string().max(1000).optional(),
});
export type DecisionResponseRequest = z.infer<typeof DecisionResponseRequestSchema>;

export const DecisionResponseSchema = z.object({
  id: z.string().uuid(),
  response: z.union([z.string(), z.boolean(), z.array(z.string())]),
  comment: z.string().optional(),
  respondedBy: z.string(),
  respondedAt: z.string().datetime(),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

export const QueueQuerySchema = z.object({
  priority: DecisionPrioritySchema.optional(),
  workflowId: z.string().optional(),
});
export type QueueQuery = z.infer<typeof QueueQuerySchema>;

export const DecisionIdParamSchema = z.object({
  id: z.string().uuid(),
});
export type DecisionIdParam = z.infer<typeof DecisionIdParamSchema>;

// ============================================================================
// Agent Types
// ============================================================================

export const AgentTypeSchema = z.enum(['claude', 'gpt4', 'custom']);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentConnectionStatusSchema = z.enum(['connected', 'idle', 'busy', 'disconnected']);
export type AgentConnectionStatus = z.infer<typeof AgentConnectionStatusSchema>;

export const ConnectedAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: AgentTypeSchema,
  status: AgentConnectionStatusSchema,
  capabilities: z.array(z.string()),
  lastSeen: z.string().datetime(),
  metadata: z.object({
    version: z.string().optional(),
    platform: z.string().optional(),
    workflowId: z.string().uuid().optional(),
  }),
});
export type ConnectedAgent = z.infer<typeof ConnectedAgentSchema>;

// ============================================================================
// Integration Types
// ============================================================================

export const IntegrationTypeSchema = z.enum(['github', 'gitlab', 'jira', 'slack', 'linear']);
export type IntegrationType = z.infer<typeof IntegrationTypeSchema>;

export const IntegrationStatusValueSchema = z.enum(['connected', 'disconnected', 'error']);
export type IntegrationStatusValue = z.infer<typeof IntegrationStatusValueSchema>;

export const IntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: IntegrationTypeSchema,
  status: IntegrationStatusValueSchema,
  lastSync: z.string().datetime().nullable().optional(),
  config: z.object({
    enabled: z.boolean(),
    autoSync: z.boolean().optional(),
  }),
  error: z.string().nullable().optional(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const IntegrationStatusSchema = z.object({
  integrations: z.array(IntegrationSchema),
});
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;

// ============================================================================
// Health Types
// ============================================================================

export const HealthStatusSchema = z.enum(['ok', 'degraded', 'error']);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const ServiceStatusSchema = z.enum(['ok', 'error']);
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ============================================================================
// Session Types
// ============================================================================

export const SessionTypeSchema = z.enum(['automated', 'developer']);
export type SessionType = z.infer<typeof SessionTypeSchema>;

export const SessionMetadataSchema = z.object({
  sessionId: z.string().uuid(),
  slug: z.string().nullable(),
  startedAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  messageCount: z.number().int().nonnegative(),
  model: z.string().nullable(),
  gitBranch: z.string().nullable(),
  type: SessionTypeSchema,
  workspace: z.string().nullable(),
});
export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

export const ListSessionsQuerySchema = z.object({
  workspace: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

export const SessionListResponseSchema = z.object({
  sessions: z.array(SessionMetadataSchema),
  pagination: PaginationSchema,
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

// ============================================================================
// Authentication Types
// ============================================================================

export const ApiScopeSchema = z.enum([
  'workflows:read',
  'workflows:write',
  'queue:read',
  'queue:write',
  'agents:read',
  'sessions:read',
  'admin',
]);
export type ApiScope = z.infer<typeof ApiScopeSchema>;

export interface ApiKeyCredential {
  /** Hashed API key (never stored plain) */
  key: string;
  /** Human-readable name */
  name: string;
  /** Creation timestamp */
  createdAt: string;
  /** Last usage timestamp */
  lastUsedAt?: string;
  /** Expiration timestamp */
  expiresAt?: string;
  /** Granted scopes */
  scopes: ApiScope[];
  /** Custom rate limit */
  rateLimit?: {
    max: number;
    timeWindow: string;
  };
}

export interface JWTPayload {
  /** Subject (user ID) */
  sub: string;
  /** User's display name */
  name: string;
  /** User's email */
  email: string;
  /** Authentication provider */
  provider: 'github';
  /** Granted scopes */
  scopes: ApiScope[];
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

/**
 * Authenticated user context available on requests
 */
export interface AuthContext {
  /** User ID */
  userId: string;
  /** Authentication method */
  method: 'api-key' | 'jwt';
  /** Granted scopes */
  scopes: ApiScope[];
  /** API key name (if api-key auth) */
  apiKeyName?: string;
}
