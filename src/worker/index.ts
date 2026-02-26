/**
 * Worker Service Module
 *
 * Provides job processing capabilities for the Generacy platform.
 * Processes jobs from the scheduler queue using type-specific handlers.
 */

import { createWorkerConfig as _createWorkerConfig } from './config/index.js';
import { WorkerProcessor as _WorkerProcessor } from './worker-processor.js';

// Types
export type {
  WorkerConfig,
  WorkerStatus,
  WorkerMetrics,
  WorkerHeartbeat,
  JobHandler,
  JobResult,
  AgentJobPayload,
  HumanJobPayload,
  IntegrationJobPayload,
  AgentJobResult,
  HumanJobResult,
  IntegrationJobResult,
  DecisionOption,
  EscalationConfig,
  HealthResponse,
  HealthConfig,
  HeartbeatConfig,
  AgentHandlerConfig,
  HumanHandlerConfig,
  IntegrationHandlerConfig,
  AgentRetryConfig,
  IntegrationRetryConfig,
  ContainerConfig,
  ContainerOverrides,
  VolumeMount,
} from './types.js';

// Configuration
export {
  DEFAULT_WORKER_CONFIG,
  DEFAULT_AGENT_RETRY_CONFIG,
  DEFAULT_INTEGRATION_RETRY_CONFIG,
  DEFAULT_HEALTH_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  createWorkerConfig,
  validateWorkerConfig,
} from './config/index.js';

// WorkerProcessor
export {
  WorkerProcessor,
  type JobSchedulerLike,
  type AgentRegistryLike,
  type MessageRouterLike,
} from './worker-processor.js';

// Retry Policies
export {
  ExponentialBackoffPolicy,
  NoRetryPolicy,
  StatusCodeRetryPolicy,
  type RetryPolicy,
  type CodedError,
  type HttpError,
} from './retry/index.js';

// Handlers
export {
  AgentHandler,
  HumanHandler,
  IntegrationHandler,
  type IntegrationPlugin,
} from './handlers/index.js';

// Health
export {
  HealthServer,
  Heartbeat,
  type HealthStatusProvider,
  type HeartbeatStatusProvider,
  type RedisClient,
} from './health/index.js';

/**
 * Create a new WorkerProcessor instance with the provided dependencies.
 * This is the primary factory function for creating worker instances.
 */
export function createWorker(
  scheduler: import('./worker-processor.js').JobSchedulerLike,
  agentRegistry: import('./worker-processor.js').AgentRegistryLike,
  router: import('./worker-processor.js').MessageRouterLike,
  config?: Partial<import('./types.js').WorkerConfig>
): _WorkerProcessor {
  const fullConfig = _createWorkerConfig(config || {});
  return new _WorkerProcessor(scheduler, agentRegistry, router, fullConfig);
}
