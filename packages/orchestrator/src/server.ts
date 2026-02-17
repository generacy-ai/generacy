import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';

import { type OrchestratorConfig, loadConfig, createTestConfig } from './config/index.js';
import { correlationIdHook, correlationIdResponseHook, setupGracefulShutdown } from './utils/index.js';
import { setupErrorHandler } from './middleware/error-handler.js';
import { setupRateLimit } from './middleware/rate-limit.js';
import { requestStartHook, requestEndHook } from './middleware/request-logger.js';
import { createAuthMiddleware, InMemoryApiKeyStore } from './auth/index.js';
import { registerRoutes, InMemoryIntegrationRegistry, closeAllSSEConnections } from './routes/index.js';
import { WorkflowService, InMemoryWorkflowStore } from './services/workflow-service.js';
import { QueueService, InMemoryQueueStore } from './services/queue-service.js';
import { AgentRegistry } from './services/agent-registry.js';
import { LabelSyncService } from './services/label-sync-service.js';
import { createGitHubClient } from '@generacy-ai/workflow-engine';

/**
 * Server creation options
 */
export interface CreateServerOptions {
  /** Configuration (loads from file/env if not provided) */
  config?: OrchestratorConfig;
  /** Additional Fastify options */
  fastifyOptions?: FastifyServerOptions;
  /** Skip route registration (for testing individual routes) */
  skipRoutes?: boolean;
}

/**
 * Create and configure the Fastify server
 */
export async function createServer(options: CreateServerOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();

  // Configure Fastify logger
  const loggerConfig =
    config.logging.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
        }
      : true;

  // Create Fastify instance
  const server = Fastify({
    logger: {
      level: config.logging.level,
      ...(typeof loggerConfig === 'object' ? loggerConfig : {}),
    },
    ...options.fastifyOptions,
  });

  // Store config on server for access in routes
  server.decorate('config', config);

  // Add correlation ID hooks
  server.addHook('onRequest', correlationIdHook);
  server.addHook('onSend', correlationIdResponseHook);

  // Add request logging hooks
  server.addHook('onRequest', requestStartHook);
  server.addHook('onResponse', requestEndHook);

  // Register core plugins
  await server.register(cors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  });

  await server.register(helmet, {
    // Customize helmet for API server
    contentSecurityPolicy: false, // Not needed for API
  });

  // Register JWT plugin
  await server.register(jwt, {
    secret: config.auth.jwt.secret,
    sign: {
      expiresIn: config.auth.jwt.expiresIn,
    },
  });

  // Setup rate limiting
  await setupRateLimit(server, config.rateLimit);

  // Setup error handler
  setupErrorHandler(server);

  // Setup authentication middleware
  const apiKeyStore = new InMemoryApiKeyStore();
  const authMiddleware = createAuthMiddleware({
    apiKeyStore,
    enabled: config.auth.enabled,
    skipRoutes: ['/health', '/metrics'],
  });
  server.addHook('preHandler', authMiddleware);

  // Sync labels for watched repositories
  if (config.repositories.length > 0) {
    const labelSyncService = new LabelSyncService(server.log, createGitHubClient);
    try {
      const syncResult = await labelSyncService.syncAll(config.repositories);
      server.log.info(
        `Label sync complete: ${syncResult.successfulRepos}/${syncResult.totalRepos} repos succeeded`
      );
      if (syncResult.failedRepos > 0) {
        server.log.warn(`Label sync: ${syncResult.failedRepos} repo(s) failed`);
      }
    } catch (error) {
      server.log.warn(
        `Label sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Register routes (unless skipped for testing)
  if (!options.skipRoutes) {
    // Create services with in-memory stores (can be replaced with real implementations)
    const workflowStore = new InMemoryWorkflowStore();
    const workflowService = new WorkflowService(workflowStore);

    const queueStore = new InMemoryQueueStore();
    const queueService = new QueueService(queueStore);

    const agentRegistry = new AgentRegistry();
    const integrationRegistry = new InMemoryIntegrationRegistry();

    await registerRoutes(server, {
      workflowService,
      queueService,
      agentRegistry,
      integrationRegistry,
    });

    // Note: SSE routes are registered via registerRoutes() -> setupEventsRoutes()
  }

  // Setup graceful shutdown with SSE connection cleanup
  setupGracefulShutdown(server, {
    timeout: 30000,
    logger: {
      info: (msg) => server.log.info(msg),
      error: (msg, error) => server.log.error({ err: error }, msg),
    },
    cleanup: [
      async () => {
        // Close all active SSE connections before shutdown
        closeAllSSEConnections();
      },
    ],
  });

  return server;
}

/**
 * Start the server and begin listening
 */
export async function startServer(server: FastifyInstance): Promise<string> {
  const config = (server as FastifyInstance & { config: OrchestratorConfig }).config;

  const address = await server.listen({
    port: config.server.port,
    host: config.server.host,
  });

  return address;
}

/**
 * Create a server for testing
 */
export async function createTestServer(
  configOverrides: Partial<OrchestratorConfig> = {}
): Promise<FastifyInstance> {
  const config = createTestConfig(configOverrides);
  return createServer({ config, skipRoutes: true });
}

/**
 * Create a fully configured server for production
 */
export async function createProductionServer(): Promise<FastifyInstance> {
  const config = loadConfig();
  return createServer({ config });
}

// Type augmentation for config access
declare module 'fastify' {
  interface FastifyInstance {
    config: OrchestratorConfig;
  }
}
