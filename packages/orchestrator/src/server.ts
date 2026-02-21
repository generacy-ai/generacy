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
import { LabelMonitorService } from './services/label-monitor-service.js';
import { PrFeedbackMonitorService } from './services/pr-feedback-monitor-service.js';
import { PhaseTrackerService } from './services/phase-tracker-service.js';
import { RedisQueueAdapter } from './services/redis-queue-adapter.js';
import { WorkerDispatcher } from './services/worker-dispatcher.js';
import { setupWebhookRoutes } from './routes/webhooks.js';
import { setupPrWebhookRoutes } from './routes/pr-webhooks.js';
import { setupDispatchRoutes } from './routes/dispatch.js';
import { createGitHubClient } from '@generacy-ai/workflow-engine';
import { Redis as IORedis } from 'ioredis';
import { ClaudeCliWorker } from './worker/claude-cli-worker.js';

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
    skipRoutes: ['/health', '/metrics', '/webhooks/github', '/webhooks/github/pr-review'],
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

  // Initialize Redis client (shared across services)
  let redisClient: IORedis | null = null;
  try {
    redisClient = new IORedis(config.redis.url);
    // Test connection
    await redisClient.ping();
    server.log.info('Redis connected');
  } catch (error) {
    server.log.warn(
      `Redis connection failed: ${error instanceof Error ? error.message : String(error)}. Phase tracker will operate without deduplication.`
    );
    redisClient = null;
  }

  // Initialize Redis queue adapter (replaces in-memory placeholder)
  let redisQueueAdapter: RedisQueueAdapter | null = null;
  let workerDispatcher: WorkerDispatcher | null = null;
  if (redisClient) {
    redisQueueAdapter = new RedisQueueAdapter(redisClient, server.log, {
      maxRetries: config.dispatch.maxRetries,
    });

    // Create CLI worker to handle queue items
    const cliWorker = new ClaudeCliWorker(config.worker, server.log);

    workerDispatcher = new WorkerDispatcher(
      redisQueueAdapter,
      redisClient,
      server.log,
      config.dispatch,
      cliWorker.handle.bind(cliWorker),
    );
  }

  // Initialize label monitor service
  let labelMonitorService: LabelMonitorService | null = null;
  let prFeedbackMonitorService: PrFeedbackMonitorService | null = null;
  if (config.repositories.length > 0) {
    const phaseTracker = new PhaseTrackerService(server.log, redisClient);

    // Use Redis queue adapter if available, otherwise fall back to a logging-only adapter
    const queueAdapter = redisQueueAdapter ?? {
      async enqueue(item: import('./types/index.js').QueueItem): Promise<void> {
        server.log.warn(
          { owner: item.owner, repo: item.repo, issue: item.issueNumber },
          'Item enqueued (fallback adapter — Redis unavailable)',
        );
      },
    };

    labelMonitorService = new LabelMonitorService(
      server.log,
      createGitHubClient,
      phaseTracker,
      queueAdapter,
      config.monitor,
      config.repositories,
    );

    // Initialize PR feedback monitor service (if enabled)
    if (config.prMonitor.enabled) {
      prFeedbackMonitorService = new PrFeedbackMonitorService(
        server.log,
        createGitHubClient,
        phaseTracker,
        queueAdapter,
        config.prMonitor,
        config.repositories,
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

    // Register webhook routes (if monitor service is available)
    if (labelMonitorService) {
      const watchedRepos = new Set(
        config.repositories.map(r => `${r.owner}/${r.repo}`)
      );
      await setupWebhookRoutes(server, {
        monitorService: labelMonitorService,
        webhookSecret: config.monitor.webhookSecret,
        watchedRepos,
      });
    }

    // Register PR webhook routes (if PR feedback monitor service is available)
    if (prFeedbackMonitorService) {
      const watchedRepos = new Set(
        config.repositories.map(r => `${r.owner}/${r.repo}`)
      );
      await setupPrWebhookRoutes(server, {
        monitorService: prFeedbackMonitorService,
        webhookSecret: config.prMonitor.webhookSecret,
        watchedRepos,
      });
    }

    // Register dispatch queue routes (if queue adapter is available)
    if (redisQueueAdapter) {
      await setupDispatchRoutes(server, redisQueueAdapter);
    }

    // Note: SSE routes are registered via registerRoutes() -> setupEventsRoutes()
  }

  // Start polling and dispatcher on server ready
  server.addHook('onReady', async () => {
    if (labelMonitorService) {
      // Start polling in the background (non-blocking)
      labelMonitorService.startPolling().catch((error) => {
        server.log.error({ err: error }, 'Label monitor polling failed');
      });
    }

    if (prFeedbackMonitorService) {
      // Start PR feedback polling in the background (non-blocking)
      prFeedbackMonitorService.startPolling().catch((error) => {
        server.log.error({ err: error }, 'PR feedback monitor polling failed');
      });
    }

    if (workerDispatcher) {
      // Start worker dispatcher in the background (non-blocking)
      workerDispatcher.start().catch((error) => {
        server.log.error({ err: error }, 'Worker dispatcher failed');
      });
    }
  });

  // Setup graceful shutdown with SSE connection cleanup
  setupGracefulShutdown(server, {
    timeout: Math.max(30000, config.dispatch.shutdownTimeoutMs),
    logger: {
      info: (msg) => server.log.info(msg),
      error: (msg, error) => server.log.error({ err: error }, msg),
    },
    cleanup: [
      async () => {
        // Stop worker dispatcher (waits for in-flight workers)
        if (workerDispatcher) {
          await workerDispatcher.stop();
        }
        // Stop label monitor polling
        if (labelMonitorService) {
          labelMonitorService.stopPolling();
        }
        // Stop PR feedback monitor polling
        if (prFeedbackMonitorService) {
          prFeedbackMonitorService.stopPolling();
        }
        // Close all active SSE connections before shutdown
        closeAllSSEConnections();
        // Close Redis connection
        if (redisClient) {
          await redisClient.quit();
        }
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
