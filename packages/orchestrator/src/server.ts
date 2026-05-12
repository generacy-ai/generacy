import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';

import { type OrchestratorConfig, loadConfig, createTestConfig } from './config/index.js';
import type { QueueManager } from './types/index.js';
import { correlationIdHook, correlationIdResponseHook, setupGracefulShutdown } from './utils/index.js';
import { setupErrorHandler } from './middleware/error-handler.js';
import { setupRateLimit } from './middleware/rate-limit.js';
import { requestStartHook, requestEndHook } from './middleware/request-logger.js';
import { createAuthMiddleware, InMemoryApiKeyStore } from './auth/index.js';
import { registerRoutes, InMemoryIntegrationRegistry, closeAllSSEConnections, setupHealthRoutes } from './routes/index.js';
import { getSSESubscriptionManager } from './sse/subscriptions.js';
import { WorkflowService, InMemoryWorkflowStore } from './services/workflow-service.js';
import { QueueService, InMemoryQueueStore } from './services/queue-service.js';
import { AgentRegistry } from './services/agent-registry.js';
import { LabelSyncService } from './services/label-sync-service.js';
import { LabelMonitorService } from './services/label-monitor-service.js';
import { PrFeedbackMonitorService } from './services/pr-feedback-monitor-service.js';
import { PhaseTrackerService } from './services/phase-tracker-service.js';
import { RedisQueueAdapter } from './services/redis-queue-adapter.js';
import { InMemoryQueueAdapter } from './services/in-memory-queue-adapter.js';
import { WorkerDispatcher } from './services/worker-dispatcher.js';
import { SmeeWebhookReceiver } from './services/smee-receiver.js';
import { RelayBridge } from './services/relay-bridge.js';
import { LeaseManager } from './services/lease-manager.js';
import { WebhookSetupService } from './services/webhook-setup-service.js';
import { setupWebhookRoutes } from './routes/webhooks.js';
import { setupPrWebhookRoutes } from './routes/pr-webhooks.js';
import { setupDispatchRoutes } from './routes/dispatch.js';
import { createGitHubClient } from '@generacy-ai/workflow-engine';
import { resolveClusterIdentity } from './services/identity.js';
import { Redis as IORedis } from 'ioredis';
import { ClaudeCliWorker } from './worker/claude-cli-worker.js';
import { existsSync } from 'node:fs';
import { ConversationManager } from './conversation/conversation-manager.js';
import { ConversationSpawner } from './conversation/conversation-spawner.js';
import { conversationProcessFactory } from './conversation/process-factory.js';
import { createAgentLauncher } from './launcher/launcher-setup.js';
import { CredhelperHttpClient } from './launcher/credhelper-client.js';
import { defaultProcessFactory } from './worker/claude-cli-worker.js';
import { setupConversationRoutes } from './routes/conversations.js';
import { setupSessionDetailRoutes } from './routes/sessions.js';
import { SessionService } from './services/session-service.js';
import { activate } from './activation/index.js';
import { StatusReporter } from './services/status-reporter.js';
import { TunnelHandler, getCodeServerManager } from '@generacy-ai/control-plane';
import { setupInternalRelayEventsRoute } from './routes/internal-relay-events.js';

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
  /** Pre-configured API key store (creates a new one if not provided) */
  apiKeyStore?: InMemoryApiKeyStore;
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
    disableRequestLogging: true, // Custom request-logger hooks handle this
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
  const apiKeyStore = options.apiKeyStore ?? new InMemoryApiKeyStore();
  const authMiddleware = createAuthMiddleware({
    apiKeyStore,
    enabled: config.auth.enabled,
    skipRoutes: ['/health', '/metrics', '/webhooks/github', '/webhooks/github/pr-review'],
  });
  server.addHook('preHandler', authMiddleware);

  // Resolve cluster identity for assignee-based issue filtering
  const clusterGithubUsername = await resolveClusterIdentity(
    config.monitor.clusterGithubUsername,
    server.log,
  );

  const isWorkerMode = config.mode === 'worker';

  // Sync labels for watched repositories (skip in worker mode)
  if (!isWorkerMode && config.repositories.length > 0) {
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
    redisClient = new IORedis(config.redis.url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      retryStrategy: () => null, // Don't retry — fall back to in-memory
    });
    // Test connection
    await redisClient.ping();
    server.log.info('Redis connected');
  } catch (error) {
    if (isWorkerMode) {
      // Workers MUST have Redis to coordinate with the orchestrator
      throw new Error(
        `Redis connection failed (required in worker mode): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    server.log.warn(
      `Redis connection failed: ${error instanceof Error ? error.message : String(error)}. Phase tracker will operate without deduplication.`
    );
    redisClient = null;
  }

  // Initialize queue adapter: prefer Redis, fall back to in-memory
  let queueAdapter: QueueManager;
  if (redisClient) {
    queueAdapter = new RedisQueueAdapter(redisClient, server.log, {
      maxRetries: config.dispatch.maxRetries,
    });
  } else {
    queueAdapter = new InMemoryQueueAdapter(server.log, {
      maxRetries: config.dispatch.maxRetries,
    });
    server.log.info('Using in-memory queue adapter (Redis unavailable)');
  }

  // Create CLI worker and dispatcher (worker mode only)
  let workerDispatcher: WorkerDispatcher | null = null;
  let workerRelayClient: import('./types/relay.js').ClusterRelayClient | null = null;
  if (isWorkerMode) {
    // Create a lightweight relay client for job event emission (if API key is configured)
    let jobEventEmitter: import('./worker/types.js').JobEventEmitter | undefined;
    if (config.relay.apiKey) {
      try {
        const { ClusterRelayClient: RelayClientImpl } = await import('@generacy-ai/cluster-relay');
        workerRelayClient = new RelayClientImpl({
          apiKey: config.relay.apiKey,
          cloudUrl: config.relay.cloudUrl,
        });
        jobEventEmitter = (event: string, data: Record<string, unknown>) => {
          try {
            if (!workerRelayClient?.isConnected) return;
            workerRelayClient.send({
              type: 'event' as const,
              event,
              data,
              timestamp: new Date().toISOString(),
            } as import('./types/relay.js').RelayMessage);
          } catch (err) {
            server.log.warn(
              { err: err instanceof Error ? err.message : String(err), event },
              'Failed to emit job event (non-fatal)',
            );
          }
        };
        server.log.info('Worker relay client configured for job event emission');
      } catch (error) {
        server.log.info(
          `Worker relay client not available: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const cliWorker = new ClaudeCliWorker(config.worker, server.log, { jobEventEmitter });
    workerDispatcher = new WorkerDispatcher(
      queueAdapter,
      redisClient,
      server.log,
      config.dispatch,
      cliWorker.handle.bind(cliWorker),
    );

    // Wire lease manager into dispatcher (if relay client is available)
    if (workerRelayClient) {
      const workerLeaseManager = new LeaseManager(workerRelayClient, server.log, config.lease);
      workerDispatcher.setLeaseManager(workerLeaseManager);
    }
  }

  // Initialize label monitor service (full mode only)
  let labelMonitorService: LabelMonitorService | null = null;
  let prFeedbackMonitorService: PrFeedbackMonitorService | null = null;
  let smeeReceiver: SmeeWebhookReceiver | null = null;
  if (!isWorkerMode && config.labelMonitor && config.repositories.length > 0) {
    const phaseTracker = new PhaseTrackerService(server.log, redisClient);

    // When Smee is configured, use its fallback poll interval and disable adaptive polling
    // (Smee provides real-time events, polling is only a safety net)
    const monitorConfig = config.smee.channelUrl
      ? { ...config.monitor, pollIntervalMs: config.smee.fallbackPollIntervalMs, adaptivePolling: false }
      : config.monitor;

    labelMonitorService = new LabelMonitorService(
      server.log,
      createGitHubClient,
      phaseTracker,
      queueAdapter,
      monitorConfig,
      config.repositories,
      clusterGithubUsername,
    );

    // Create SmeeWebhookReceiver if Smee channel URL is configured
    if (config.smee.channelUrl) {
      const watchedRepos = new Set(
        config.repositories.map(r => `${r.owner}/${r.repo}`)
      );
      smeeReceiver = new SmeeWebhookReceiver(
        server.log,
        labelMonitorService,
        { channelUrl: config.smee.channelUrl, watchedRepos, clusterGithubUsername },
      );
      server.log.info({ channelUrl: config.smee.channelUrl }, 'Smee webhook receiver configured');
    }

    // Initialize PR feedback monitor service (if enabled)
    if (config.prMonitor.enabled) {
      prFeedbackMonitorService = new PrFeedbackMonitorService(
        server.log,
        createGitHubClient,
        phaseTracker,
        queueAdapter,
        config.prMonitor,
        config.repositories,
        clusterGithubUsername,
      );
    }
  }

  // Initialize relay bridge (full mode only, when API key is configured)
  let relayBridge: RelayBridge | null = null;
  let activationPending = false;

  // Register internal relay events route BEFORE server.listen() (deferred binding pattern).
  // The getter resolves to null until activation completes; the route returns 503 in that window.
  let relayClientRef: import('./types/relay.js').ClusterRelayClient | null = null;
  if (!isWorkerMode) {
    const controlPlaneKey = process.env['ORCHESTRATOR_INTERNAL_API_KEY'];
    if (controlPlaneKey) {
      apiKeyStore.addKey(controlPlaneKey, {
        name: 'control-plane-internal',
        scopes: ['admin'],
        createdAt: new Date().toISOString(),
      });
      setupInternalRelayEventsRoute(server, () => relayClientRef);
      server.log.info('Control-plane relay event IPC endpoint registered');
    }
  }

  if (!isWorkerMode && !config.relay.apiKey) {
    // Wizard mode: background the activation so server.listen() is not blocked
    activationPending = true;
    activateInBackground(config, server, apiKeyStore, (bridge, convMgr) => {
      relayBridge = bridge;
      conversationManager = convMgr;
      activationPending = false;
    }, (client) => { relayClientRef = client; }).catch((error) => {
      activationPending = false;
      server.log.warn(
        `Cluster activation skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } else if (!isWorkerMode && config.relay.apiKey) {
    // API key already exists: initialize relay bridge synchronously
    const result = await initializeRelayBridge(config, server, apiKeyStore, (client) => { relayClientRef = client; });
    relayBridge = result.relayBridge;
  }

  // Initialize ConversationManager (full mode only, when workspaces are configured)
  let conversationManager: ConversationManager | null = null;
  if (!isWorkerMode && Object.keys(config.conversations.workspaces).length > 0) {
    conversationManager = await initializeConversationManager(config, server, relayBridge);
  }

  // Register routes (unless skipped for testing)
  if (!options.skipRoutes) {
    if (isWorkerMode) {
      // Worker mode: minimal routes — health checks and dispatch observability only
      await setupHealthRoutes(server, {
        checks: {
          server: async () => 'ok',
          redis: async () => redisClient ? 'ok' : 'error',
          dispatcher: async () => workerDispatcher ? 'ok' : 'error',
        },
      });
      await setupDispatchRoutes(server, queueAdapter);
    } else {
      // Full mode: all routes
      const workflowStore = new InMemoryWorkflowStore();
      const workflowService = new WorkflowService(workflowStore);

      const queueStore = new InMemoryQueueStore();
      const queueService = new QueueService(queueStore);

      const agentRegistry = new AgentRegistry();
      const integrationRegistry = new InMemoryIntegrationRegistry();
      const sessionService = new SessionService({
        workspaces: config.conversations.workspaces,
      });

      await registerRoutes(server, {
        workflowService,
        queueService,
        agentRegistry,
        integrationRegistry,
        sessionService,
      });

      // Register webhook routes inside an encapsulated plugin so the custom
      // application/json content-type parser (needed for raw-body signature
      // verification) is scoped to webhook routes only and registered exactly once.
      const hasWebhookRoutes = labelMonitorService || prFeedbackMonitorService;
      if (hasWebhookRoutes) {
        await server.register(async (webhookScope) => {
          // Replace the default JSON parser with one that preserves the raw body
          // for HMAC-SHA256 signature verification.
          webhookScope.removeContentTypeParser('application/json');
          webhookScope.addContentTypeParser(
            'application/json',
            { parseAs: 'string' },
            (_req, body, done) => {
              try {
                const json = JSON.parse(body as string);
                done(null, { parsed: json, raw: body });
              } catch (err) {
                done(err as Error, undefined);
              }
            },
          );

          if (labelMonitorService) {
            const watchedRepos = new Set(
              config.repositories.map(r => `${r.owner}/${r.repo}`)
            );
            await setupWebhookRoutes(webhookScope, {
              monitorService: labelMonitorService,
              webhookSecret: config.monitor.webhookSecret,
              watchedRepos,
              clusterGithubUsername,
            });
          }

          if (prFeedbackMonitorService) {
            const watchedRepos = new Set(
              config.repositories.map(r => `${r.owner}/${r.repo}`)
            );
            await setupPrWebhookRoutes(webhookScope, {
              monitorService: prFeedbackMonitorService,
              webhookSecret: config.prMonitor.webhookSecret,
              watchedRepos,
              clusterGithubUsername,
            });
          }
        });
      }

      // Register conversation routes (if manager is available)
      if (conversationManager) {
        await setupConversationRoutes(server, conversationManager);
      }

      // Register session detail routes (manager is optional — isActive defaults to false without it)
      await setupSessionDetailRoutes(server, conversationManager);

      // Register dispatch queue routes
      await setupDispatchRoutes(server, queueAdapter);

      // Note: SSE routes are registered via registerRoutes() -> setupEventsRoutes()
    }
  }

  // Start services on server ready
  server.addHook('onReady', async () => {
    if (isWorkerMode) {
      // Worker mode: connect relay client (for job events) and start dispatcher
      if (workerRelayClient) {
        workerRelayClient.connect().catch((error) => {
          server.log.warn({ err: error }, 'Worker relay client connection failed (job events disabled)');
        });
      }
      if (workerDispatcher) {
        workerDispatcher.start().catch((error) => {
          server.log.error({ err: error }, 'Worker dispatcher failed');
        });
      }
    } else {
      // Full mode: start monitors, Smee, webhook setup (no dispatcher)
      if (labelMonitorService) {
        labelMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'Label monitor polling failed');
        });
      }

      if (prFeedbackMonitorService) {
        prFeedbackMonitorService.startPolling().catch((error) => {
          server.log.error({ err: error }, 'PR feedback monitor polling failed');
        });
      }

      if (smeeReceiver) {
        smeeReceiver.start().catch((error) => {
          server.log.error({ err: error }, 'Smee webhook receiver failed');
        });
      }

      if (config.webhookSetup.enabled && config.smee.channelUrl) {
        const webhookSetupService = new WebhookSetupService(server.log);
        webhookSetupService.ensureWebhooks(config.smee.channelUrl, config.repositories).catch((error) => {
          server.log.error({ err: error }, 'Webhook setup failed');
        });
      }

      // Only start relay bridge here if it was initialized synchronously.
      // The background activation path calls relayBridge.start() itself.
      if (relayBridge && !activationPending) {
        relayBridge.start().catch((error) => {
          server.log.error({ err: error }, 'Relay bridge start failed');
        });
      }
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
        if (isWorkerMode) {
          // Worker mode: stop dispatcher and disconnect relay client
          if (workerDispatcher) {
            await workerDispatcher.stop();
          }
          if (workerRelayClient) {
            await workerRelayClient.disconnect();
          }
        } else {
          // Full mode: stop conversations, relay, monitors, Smee, SSE
          if (conversationManager) {
            await conversationManager.stop();
          }
          if (relayBridge) {
            await relayBridge.stop();
          }
          if (smeeReceiver) {
            smeeReceiver.stop();
          }
          if (labelMonitorService) {
            labelMonitorService.stopPolling();
          }
          if (prFeedbackMonitorService) {
            prFeedbackMonitorService.stopPolling();
          }
          closeAllSSEConnections();
        }
        // Close Redis connection (both modes)
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

/**
 * Run cluster activation in the background so server.listen() is not blocked.
 * On success, initializes relay bridge, conversation manager, and starts the relay.
 */
async function activateInBackground(
  config: OrchestratorConfig,
  server: FastifyInstance,
  apiKeyStore: InMemoryApiKeyStore,
  onInitialized: (relayBridge: RelayBridge | null, conversationManager: ConversationManager | null) => void,
  setRelayClient?: (client: import('./types/relay.js').ClusterRelayClient) => void,
): Promise<void> {
  const activationResult = await activate({
    cloudUrl: config.activation.cloudUrl,
    keyFilePath: config.activation.keyFilePath,
    clusterJsonPath: config.activation.clusterJsonPath,
    logger: server.log as unknown as import('pino').Logger,
  });

  config.relay.apiKey = activationResult.apiKey;
  config.relay.clusterApiKeyId = activationResult.clusterApiKeyId;
  if (activationResult.cloudUrl) {
    config.activation.cloudUrl = activationResult.cloudUrl;
    // Relay-server's auth middleware requires ?projectId=<id> on the upgrade
    // request (see generacy-cloud/services/api/src/middleware/relay-auth.ts).
    // Append it here so the cluster's WS connection isn't rejected with
    // 401 "projectId query parameter required" — without the relay link,
    // the cloud treats the cluster as offline and rejects credential pushes
    // with "Cluster is not connected for this project".
    const relayUrl = activationResult.cloudUrl
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
      .replace(/\/$/, '') + '/relay'
      + `?projectId=${encodeURIComponent(activationResult.projectId)}`;
    config.relay.cloudUrl = relayUrl;
  }
  server.log.info('Cluster activation complete');

  const { relayBridge } = await initializeRelayBridge(config, server, apiKeyStore, setRelayClient);
  const conversationManager = await initializeConversationManager(config, server, relayBridge);

  onInitialized(relayBridge, conversationManager);

  // Server is already listening — start relay bridge directly
  if (relayBridge) {
    await relayBridge.start();
  }
}

/**
 * Initialize relay bridge and status reporter.
 * Extracted from createServer() for reuse in background activation path.
 */
async function initializeRelayBridge(
  config: OrchestratorConfig,
  server: FastifyInstance,
  apiKeyStore: InMemoryApiKeyStore,
  setRelayClient?: (client: import('./types/relay.js').ClusterRelayClient) => void,
): Promise<{ relayBridge: RelayBridge | null; statusReporter: StatusReporter }> {
  const controlPlaneSocket = process.env['CONTROL_PLANE_SOCKET_PATH'] ?? '/run/generacy-control-plane/control.sock';
  const statusReporter = new StatusReporter({ socketPath: controlPlaneSocket });

  let relayBridge: RelayBridge | null = null;
  if (!config.relay.apiKey) {
    return { relayBridge, statusReporter };
  }
  try {
    const { ClusterRelayClient: RelayClientImpl } = await import('@generacy-ai/cluster-relay');

    const relayInternalKey = crypto.randomUUID();
    apiKeyStore.addKey(relayInternalKey, {
      name: 'relay-internal',
      scopes: ['admin'],
      createdAt: new Date().toISOString(),
    });

    const codeServerSocket = process.env['CODE_SERVER_SOCKET_PATH'] ?? '/run/generacy-control-plane/code-server.sock';

    const relayClient = new RelayClientImpl({
      apiKey: config.relay.apiKey,
      cloudUrl: config.relay.cloudUrl,
      orchestratorUrl: `http://127.0.0.1:${config.server.port}`,
      orchestratorApiKey: relayInternalKey,
      routes: [
        {
          prefix: '/control-plane',
          target: `unix://${controlPlaneSocket}`,
        },
        {
          prefix: '/code-server',
          target: `unix://${codeServerSocket}`,
        },
      ],
    });

    // Assign relay client ref for the deferred-binding route registered in createServer()
    if (setRelayClient) {
      setRelayClient(relayClient);
    }

    relayBridge = new RelayBridge({
      client: relayClient,
      server,
      sseManager: getSSESubscriptionManager(),
      logger: server.log,
      config: config.relay,
    });

    const fullModeLeaseManager = new LeaseManager(relayClient, server.log, config.lease);
    relayBridge.setLeaseManager(fullModeLeaseManager);

    const codeServerManager = getCodeServerManager();
    if (codeServerManager) {
      const tunnelHandler = new TunnelHandler(
        { send: (msg: unknown) => relayClient.send(msg as import('./types/relay.js').RelayMessage) },
        codeServerManager,
      );
      relayBridge.setTunnelHandler(tunnelHandler);

      // Push metadata immediately when code-server becomes ready (seconds-latency, not 60s heartbeat)
      const bridge = relayBridge;
      codeServerManager.onStatusChange((status) => {
        if (status === 'running') {
          bridge.sendMetadata();
        }
      });
    }

    relayBridge.setStatusReporter(statusReporter);

    server.log.info('Relay bridge configured');
  } catch (error) {
    server.log.info(
      `Relay bridge not available: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { relayBridge, statusReporter };
}

/**
 * Initialize ConversationManager.
 * Extracted from createServer() for reuse in background activation path.
 */
async function initializeConversationManager(
  config: OrchestratorConfig,
  server: FastifyInstance,
  relayBridge: RelayBridge | null,
): Promise<ConversationManager | null> {
  if (Object.keys(config.conversations.workspaces).length === 0) {
    return null;
  }

  const convSocketPath = process.env['GENERACY_CREDHELPER_SOCKET'] ?? '/run/generacy-credhelper/control.sock';
  const convCredhelperClient = existsSync(convSocketPath)
    ? new CredhelperHttpClient({ socketPath: convSocketPath })
    : undefined;

  const agentLauncher = createAgentLauncher({
    default: defaultProcessFactory,
    interactive: conversationProcessFactory,
  }, convCredhelperClient);
  const conversationSpawner = new ConversationSpawner(
    agentLauncher,
    config.conversations.shutdownGracePeriodMs,
    config.worker.credentialRole,
  );
  const conversationManager = new ConversationManager(
    config.conversations,
    conversationSpawner,
    server.log,
  );

  if (relayBridge) {
    relayBridge.setConversationManager(conversationManager);
  }

  server.log.info(
    { workspaces: Object.keys(config.conversations.workspaces) },
    'Conversation manager configured',
  );

  return conversationManager;
}

// Type augmentation for config access
declare module 'fastify' {
  interface FastifyInstance {
    config: OrchestratorConfig;
  }
}
