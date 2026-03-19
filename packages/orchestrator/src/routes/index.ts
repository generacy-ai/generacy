import type { FastifyInstance } from 'fastify';
import { setupHealthRoutes, type HealthCheckOptions } from './health.js';
import { setupMetricsRoutes } from './metrics.js';
import { setupWorkflowRoutes } from './workflows.js';
import { setupQueueRoutes } from './queue.js';
import { setupAgentRoutes } from './agents.js';
import { setupIntegrationRoutes, type IntegrationRegistry } from './integrations.js';
import { setupEventsRoutes } from './events.js';
import { setupFileRoutes } from './files.js';
import { setupSessionRoutes } from './sessions.js';
import type { WorkflowService } from '../services/workflow-service.js';
import type { QueueService } from '../services/queue-service.js';
import type { AgentRegistry } from '../services/agent-registry.js';
import type { SessionService } from '../services/session-service.js';

/**
 * Route registration options
 */
export interface RouteRegistrationOptions {
  /** Workflow service */
  workflowService: WorkflowService;
  /** Queue service */
  queueService: QueueService;
  /** Agent registry */
  agentRegistry: AgentRegistry;
  /** Integration registry */
  integrationRegistry: IntegrationRegistry;
  /** Session service */
  sessionService: SessionService;
  /** Health check options */
  healthCheckOptions?: HealthCheckOptions;
}

/**
 * Register all routes
 */
export async function registerRoutes(
  server: FastifyInstance,
  options: RouteRegistrationOptions
): Promise<void> {
  // System routes (no auth required)
  await setupHealthRoutes(server, options.healthCheckOptions);
  await setupMetricsRoutes(server);

  // API routes (auth required)
  await setupWorkflowRoutes(server, options.workflowService);
  await setupQueueRoutes(server, options.queueService);
  await setupAgentRoutes(server, options.agentRegistry);
  await setupIntegrationRoutes(server, options.integrationRegistry);

  // Session routes (auth required)
  await setupSessionRoutes(server, options.sessionService);

  // File read/write routes (used by relay for cluster config, etc.)
  await setupFileRoutes(server);

  // SSE event routes
  await setupEventsRoutes(server);
}

// Re-export route setup functions
export { setupHealthRoutes, type HealthCheckOptions } from './health.js';
export { setupMetricsRoutes, initializeMetrics, recordHttpRequest } from './metrics.js';
export { setupWorkflowRoutes } from './workflows.js';
export { setupQueueRoutes } from './queue.js';
export { setupAgentRoutes } from './agents.js';
export {
  setupIntegrationRoutes,
  InMemoryIntegrationRegistry,
  type IntegrationRegistry,
} from './integrations.js';
export {
  setupEventsRoutes,
  getActiveConnectionCount,
  closeAllSSEConnections,
} from './events.js';
export { setupFileRoutes } from './files.js';
export { setupSessionRoutes, setupSessionDetailRoutes } from './sessions.js';
export {
  setupWebhookRoutes,
  type WebhookRouteOptions,
} from './webhooks.js';
export {
  setupPrWebhookRoutes,
  type PrWebhookRouteOptions,
} from './pr-webhooks.js';
export { setupDispatchRoutes } from './dispatch.js';
