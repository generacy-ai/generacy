/**
 * Generacy Message Router
 *
 * A message routing system that connects Agency instances with Humancy.
 *
 * @packageDocumentation
 */

// Types
export type {
  MessageType,
  EndpointType,
  MessageEndpoint,
  MessageMeta,
  MessageEnvelope,
  MessageHandler,
  HumancyType,
  ConnectionStatus,
  BaseConnection,
  AgencyConnection,
  HumancyConnection,
  Connection,
  RegisteredConnection,
  ChannelContext,
  ChannelHandler,
  Channel,
  RedisConfig,
  RetryConfig,
  RouterConfig,
} from './types/index.js';

// Type utilities and constants
export {
  DEFAULT_TTL,
  createMessageEnvelope,
  isMessageExpired,
  isAgencyConnection,
  isHumancyConnection,
  RESERVED_CHANNEL_NAMES,
  CHANNEL_NAME_PATTERN,
  isValidChannelName,
  InvalidChannelNameError,
  ChannelExistsError,
  ChannelNotFoundError,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_REDIS_CONFIG,
  createRouterConfig,
} from './types/index.js';

// Router
export {
  MessageRouter,
  type MessageRouterEvents,
  type RouteOptions,
  determineRoute,
  validateMessageForRouting,
  expectsResponse,
  getSourceTypeConstraint,
  RoutingError,
  DestinationNotFoundError,
  NoRecipientsError,
  type RouteTarget,
  type RoutingDecision,
  CorrelationManager,
  CorrelationTimeoutError,
  CorrelationCancelledError,
  type CorrelationManagerEvents,
} from './router/index.js';

// Connections
export {
  ConnectionRegistry,
  ConnectionExistsError,
  ConnectionNotFoundError,
  type ConnectionRegistryEvents,
  createAgencyConnection,
  createMockAgencyConnection,
  type AgencyConnectionOptions,
  createHumancyConnection,
  createMockHumancyConnection,
  type HumancyConnectionOptions,
} from './connections/index.js';

// Channels
export {
  ChannelRegistry,
  type ChannelRegistryEvents,
  ChannelMessageHandler,
  type ChannelMessageHandlerEvents,
  type ChannelMessageHandlerOptions,
} from './channels/index.js';

// Persistence
export {
  RedisStore,
  REDIS_KEYS,
  type StoredConnection,
  MessageQueue,
  type MessageQueueEvents,
  type DeliveryFunction,
  DeadLetterQueue,
  type DeadLetterEntry,
  type DeadLetterStatus,
  type DeadLetterQueueEvents,
} from './persistence/index.js';

// Utilities
export {
  MaxRetriesExceededError,
  calculateRetryDelay,
  calculateRetryDelayDeterministic,
  retry,
  withRetry,
  type RetryOptions,
  calculateExpiration,
  calculateRemainingTtl,
  isExpired,
  ttlToSeconds,
  remainingTtlToSeconds,
  parseTtl,
  formatTtl,
} from './utils/index.js';

// Baseline Recommendation Generator
export {
  BaselineRecommendationGenerator,
  RecommendationGenerationError,
  AIResponseParseError,
  PromptBuilder,
  ConfidenceCalculator,
  DEFAULT_BASELINE_CONFIG,
  type DecisionRequest,
  type DecisionOption,
  type ProjectContext,
  type DecisionConstraints,
  type BaselineRecommendation,
  type ConsiderationFactor,
  type AlternativeAnalysis,
  type BaselineConfig,
  type FactorConfig,
} from './baseline/index.js';

// Services
export {
  MockAIService,
  type AIService,
  type AICompletionRequest,
  type AICompletionResponse,
  type AITokenUsage,
} from './services/index.js';

// Agents
export {
  AgentFeature,
  type AgentInvoker,
  type InvocationConfig,
  type InvocationContext,
  type InvocationResult,
  type ToolCallRecord,
  type InvocationError,
  AgentUnavailableError,
  AgentInitializationError,
  AgentNotFoundError,
  DefaultAgentNotConfiguredError,
  AgentExistsError,
  InvocationErrorCodes,
  AgentRegistry,
  ClaudeCodeInvoker,
} from './agents/index.js';
