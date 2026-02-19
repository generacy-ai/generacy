// Server
export { createServer, startServer, createTestServer, type CreateServerOptions } from './server.js';

// Configuration
export {
  loadConfig,
  createTestConfig,
  validateConfig,
  type OrchestratorConfig,
  type ServerConfig,
  type RedisConfig,
  type AuthConfig,
  type RateLimitConfig,
  type CorsConfig,
  type LoggingConfig,
  type LoadConfigOptions,
  type MonitorConfig,
  type RepositoryConfig,
  type DispatchConfig,
} from './config/index.js';

// Types
export {
  // Problem Details
  type ProblemDetails,
  type ValidationError,
  type ErrorType,
  ErrorTypes,
  createProblemDetails,
  // Workflow
  type WorkflowStatus,
  type CreateWorkflowRequest,
  type WorkflowResponse,
  type WorkflowListResponse,
  type ListWorkflowsQuery,
  type Pagination,
  // Decision Queue
  type DecisionType,
  type DecisionPriority,
  type DecisionOption,
  type DecisionQueueItem,
  type CreateDecisionRequest,
  type DecisionResponseRequest,
  type DecisionResponse,
  type QueueQuery,
  // Agents
  type AgentType,
  type AgentConnectionStatus,
  type ConnectedAgent,
  // Integrations
  type IntegrationType,
  type IntegrationStatusValue,
  type Integration,
  type IntegrationStatus,
  // Health
  type HealthStatus,
  type ServiceStatus,
  type HealthResponse,
  // Authentication
  type ApiScope,
  type ApiKeyCredential,
  type JWTPayload,
  type GitHubUser,
  type AuthContext,
  // SSE
  type SSEChannel,
  type SSEEventType,
  type SSEEvent,
  type WorkflowEventData,
  type WorkflowSSEEvent,
  type QueueEventData,
  type QueueSSEEvent,
  type AgentEventData,
  type AgentSSEEvent,
  type ErrorEventData,
  type ErrorSSEEvent,
  type SSEFilters,
  type SSESubscription,
  type SSEConnection,
  type SSEConnectionOptions,
  type SSEStreamConfig,
  DEFAULT_SSE_CONFIG,
  // Monitor
  type QueueItem,
  type LabelEvent,
  type GitHubWebhookPayload,
  type MonitorState,
  type QueueAdapter,
  type PhaseTracker,
  // Dispatch Queue
  type QueueItemWithScore,
  type SerializedQueueItem,
  type QueueManager,
  type WorkerInfo,
  type WorkerHandler,
} from './types/index.js';

// Services
export {
  WorkflowService,
  InMemoryWorkflowStore,
  type WorkflowEngine,
} from './services/workflow-service.js';

export {
  QueueService,
  InMemoryQueueStore,
  type MessageRouter,
} from './services/queue-service.js';

export {
  AgentRegistry,
  type AgentRegistration,
} from './services/agent-registry.js';

export {
  LabelSyncService,
  type LabelSyncResult,
  type RepoSyncResult,
  type SyncAllResult,
} from './services/label-sync-service.js';

export {
  LabelMonitorService,
  type LabelMonitorOptions,
} from './services/label-monitor-service.js';

export {
  SmeeWebhookReceiver,
  type SmeeReceiverOptions,
} from './services/smee-receiver.js';

export {
  PhaseTrackerService,
  type PhaseTrackerOptions,
} from './services/phase-tracker-service.js';

export { RedisQueueAdapter } from './services/redis-queue-adapter.js';

export { WorkerDispatcher } from './services/worker-dispatcher.js';

// Auth
export {
  API_KEY_HEADER,
  hashApiKey,
  validateApiKey,
  InMemoryApiKeyStore,
  type ApiKeyStore,
} from './auth/api-key.js';

export {
  createAuthMiddleware,
  requireScopes,
  requireRead,
  requireWrite,
  type AuthMiddlewareOptions,
} from './auth/middleware.js';

// Middleware
export {
  setupRateLimit,
  generateRateLimitKey,
} from './middleware/rate-limit.js';

export {
  setupErrorHandler,
  HttpError,
  Errors,
} from './middleware/error-handler.js';

// Routes
export {
  registerRoutes,
  type RouteRegistrationOptions,
} from './routes/index.js';

export {
  InMemoryIntegrationRegistry,
  type IntegrationRegistry,
} from './routes/integrations.js';

// SSE
export {
  SSEStream,
  createSSEStream,
  parseLastEventId,
  formatSSEEvent,
  formatHeartbeat,
  createWorkflowEvent,
  createQueueEvent,
  createAgentEvent,
  createErrorEvent,
  createConnectedEvent,
  SSESubscriptionManager,
  getSSESubscriptionManager,
  resetSSESubscriptionManager,
} from './sse/index.js';

export {
  setupEventsRoutes,
  getActiveConnectionCount,
  closeAllSSEConnections,
} from './routes/events.js';

// Utils
export {
  setupGracefulShutdown,
  CORRELATION_ID_HEADER,
  generateCorrelationId,
} from './utils/index.js';
