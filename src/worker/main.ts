/**
 * Worker Service Entry Point
 *
 * Standalone executable for the worker service that:
 * - Initializes dependencies (scheduler, agent registry, router)
 * - Creates and starts the WorkerProcessor
 * - Starts the health server and heartbeat
 * - Handles graceful shutdown on SIGTERM/SIGINT
 */

import { Redis } from 'ioredis';
import { WorkerProcessor, type MessageRouterLike } from './worker-processor.js';
import { HealthServer, type HealthStatusProvider } from './health/health-server.js';
import { Heartbeat, type HeartbeatStatusProvider } from './health/heartbeat.js';
import { AgentHandler } from './handlers/agent-handler.js';
import { HumanHandler } from './handlers/human-handler.js';
import { IntegrationHandler, type IntegrationPlugin } from './handlers/integration-handler.js';
import { createWorkerConfig } from './config/index.js';
import { JobScheduler, RedisBackend } from '../scheduler/index.js';
import { AgentRegistry, ClaudeCodeInvoker } from '../agents/index.js';
import { createAgentLauncher, defaultProcessFactory, conversationProcessFactory } from '@generacy-ai/orchestrator';
import { MessageRouter, CorrelationManager } from '../router/index.js';
import type { WorkerConfig, HeartbeatConfig, HealthConfig } from './types.js';
import type { RedisConfig } from '../types/config.js';

/**
 * Load configuration from environment variables.
 */
function loadConfigFromEnv(): Partial<WorkerConfig> {
  return {
    workerId: process.env.WORKER_ID || `worker-${process.pid}`,
    pollInterval: parseInt(process.env.POLL_INTERVAL || '1000', 10),
    gracefulShutdownTimeout: parseInt(process.env.GRACEFUL_SHUTDOWN_TIMEOUT || '30000', 10),
    forceShutdownOnTimeout: process.env.FORCE_SHUTDOWN_ON_TIMEOUT === 'true',
    health: {
      enabled: process.env.HEALTH_ENABLED !== 'false',
      port: parseInt(process.env.HEALTH_PORT || '3001', 10),
    } as HealthConfig,
    heartbeat: {
      enabled: process.env.HEARTBEAT_ENABLED !== 'false',
      interval: parseInt(process.env.HEARTBEAT_INTERVAL || '5000', 10),
      ttl: parseInt(process.env.HEARTBEAT_TTL || '30000', 10),
    } as HeartbeatConfig,
  };
}

/**
 * Get Redis configuration from environment.
 */
function getRedisConfig(): RedisConfig {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  };
}

/**
 * Create Redis connection from environment.
 */
function createRedisConnection(): Redis {
  const config = getRedisConfig();
  return new Redis({
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });
}

/**
 * Create a health status provider adapter for the WorkerProcessor.
 */
function createHealthStatusProvider(
  worker: WorkerProcessor,
  redis: Redis
): HealthStatusProvider {
  let queueDepth = 0;
  let lastCompletedTime: string | null = null;

  worker.on('job:completed', () => {
    lastCompletedTime = new Date().toISOString();
  });

  worker.on('metrics:snapshot', (metrics: { jobsProcessed: number }) => {
    queueDepth = metrics.jobsProcessed;
  });

  return {
    isHealthy: () => worker.isHealthy(),
    getCurrentJobCount: () => (worker.isProcessing() ? 1 : 0),
    getLastCompletedTime: () => lastCompletedTime,
    getRedisStatus: () => (redis.status === 'ready' ? 'connected' : 'disconnected'),
    getQueueDepth: () => queueDepth,
  };
}

/**
 * Create a heartbeat status provider adapter for the WorkerProcessor.
 */
function createHeartbeatStatusProvider(worker: WorkerProcessor): HeartbeatStatusProvider {
  return {
    getStatus: () => worker.getStatus(),
    getCurrentJob: () => {
      const job = worker.getCurrentJob();
      return job ? { id: job.id } : undefined;
    },
    getMetrics: () => worker.getMetrics(),
  };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  console.log('[worker] Starting worker service...');

  // Load configuration
  const envConfig = loadConfigFromEnv();
  const config = createWorkerConfig(envConfig);
  const workerId = config.workerId ?? `worker-${process.pid}`;
  console.log(`[worker] Worker ID: ${workerId}`);

  // Create Redis connection for worker operations
  const redis = createRedisConnection();
  await redis.connect();
  console.log('[worker] Connected to Redis');

  // Create scheduler with Redis backend
  const redisConfig = getRedisConfig();
  const backend = new RedisBackend(redisConfig);
  await backend.connect();
  const scheduler = new JobScheduler({ backend });
  console.log('[worker] Job scheduler initialized');

  // Create agent launcher and registry
  const agentLauncher = createAgentLauncher({
    default: defaultProcessFactory,
    interactive: conversationProcessFactory,
  });
  const registry = new AgentRegistry();
  const claudeCode = new ClaudeCodeInvoker(agentLauncher);
  registry.register(claudeCode);
  registry.setDefault(claudeCode.name);
  console.log('[worker] Agent registry initialized');

  // Create message router with correlation manager
  const router = new MessageRouter();
  const correlationManager = new CorrelationManager();
  router.correlationManager = correlationManager;
  console.log('[worker] Message router initialized');

  // Create worker processor - cast router to MessageRouterLike
  const worker = new WorkerProcessor(
    scheduler,
    registry,
    router as unknown as MessageRouterLike,
    config
  );

  // Register handlers
  const integrations = new Map<string, IntegrationPlugin>();
  worker.registerHandler('agent', new AgentHandler(registry, config.handlers.agent));
  worker.registerHandler('human', new HumanHandler(router, config.handlers.human));
  worker.registerHandler('integration', new IntegrationHandler(integrations, config.handlers.integration));
  console.log('[worker] Job handlers registered');

  // Create health server
  const healthProvider = createHealthStatusProvider(worker, redis);
  const healthServer = new HealthServer(healthProvider, config.health);

  // Create heartbeat
  const heartbeatProvider = createHeartbeatStatusProvider(worker);
  const heartbeat = new Heartbeat(
    redis,
    workerId,
    heartbeatProvider,
    config.heartbeat
  );

  // Setup shutdown handler
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[worker] Received ${signal}, initiating graceful shutdown...`);

    try {
      // Stop accepting new jobs
      await worker.stop();
      console.log('[worker] Worker stopped');

      // Stop health server
      await healthServer.stop();
      console.log('[worker] Health server stopped');

      // Stop heartbeat
      heartbeat.stop();
      console.log('[worker] Heartbeat stopped');

      // Disconnect Redis and backend
      await backend.disconnect();
      await redis.quit();
      console.log('[worker] Redis disconnected');

      console.log('[worker] Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[worker] Error during shutdown:', error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start services
  try {
    await healthServer.start();
    console.log(`[worker] Health server listening on port ${config.health.port}`);

    heartbeat.start();
    console.log('[worker] Heartbeat started');

    await worker.start();
    console.log('[worker] Worker processor started, polling for jobs...');

    // Log worker events
    worker.on('job:started', (job) => {
      console.log(`[worker] Job started: ${job.id} (type: ${job.type})`);
    });

    worker.on('job:completed', (job, result) => {
      console.log(`[worker] Job completed: ${job.id} (success: ${result.success})`);
    });

    worker.on('job:failed', (job, error) => {
      console.error(`[worker] Job failed: ${job.id}`, error.message);
    });

    worker.on('shutdown:initiated', () => {
      console.log('[worker] Shutdown initiated, draining current job...');
    });

    worker.on('shutdown:timeout', (job) => {
      console.warn(`[worker] Shutdown timeout, job still running: ${job?.id}`);
    });
  } catch (error) {
    console.error('[worker] Failed to start worker:', error);
    await backend.disconnect();
    await redis.quit();
    process.exit(1);
  }
}

// Run main
main().catch((error) => {
  console.error('[worker] Fatal error:', error);
  process.exit(1);
});
