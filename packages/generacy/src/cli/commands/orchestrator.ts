/**
 * Orchestrator command implementation.
 * Starts the orchestrator HTTP server for worker coordination.
 * Optionally enables label monitoring to watch GitHub repos for process:* labels.
 */
import { Command } from 'commander';
import { getLogger } from '../utils/logger.js';
import { createOrchestratorServer } from '../../orchestrator/index.js';
import { createJobQueue } from '../../orchestrator/redis-job-queue.js';
import { LabelMonitorBridge } from '../../orchestrator/label-monitor-bridge.js';

/**
 * Create the orchestrator command
 */
export function orchestratorCommand(): Command {
  const command = new Command('orchestrator');

  command
    .description('Start the orchestrator server that coordinates workers and distributes jobs')
    .option('-p, --port <port>', 'HTTP server port', '3100')
    .option('-h, --host <host>', 'Host to bind to', '0.0.0.0')
    .option('--worker-timeout <ms>', 'Worker heartbeat timeout in milliseconds', '60000')
    .option('--auth-token <token>', 'Authentication token (or set ORCHESTRATOR_TOKEN env var)')
    .option('--redis-url <url>', 'Redis URL for persistent job queue (or set REDIS_URL env var)')
    .option('--label-monitor', 'Enable GitHub label monitoring (or set LABEL_MONITOR_ENABLED=true)')
    .option('--poll-interval <ms>', 'Label monitor poll interval in milliseconds (or set POLL_INTERVAL_MS)')
    .option('--monitored-repos <repos>', 'Comma-separated owner/repo list (or set MONITORED_REPOS)')
    .action(async (options) => {
      const logger = getLogger();

      const port = parseInt(options['port'], 10);
      const host = options['host'] as string;
      const workerTimeout = parseInt(options['workerTimeout'], 10);
      const authToken = options['authToken'] as string | undefined;
      const redisUrl = (options['redisUrl'] as string | undefined) ?? process.env['REDIS_URL'];

      // Validate port
      if (isNaN(port) || port < 1 || port > 65535) {
        logger.error('Invalid port number. Must be between 1 and 65535.');
        process.exit(1);
      }

      // Validate timeout
      if (isNaN(workerTimeout) || workerTimeout < 1000) {
        logger.error('Invalid worker timeout. Must be at least 1000ms.');
        process.exit(1);
      }

      const loggerAdapter = {
        info: (message: string, data?: Record<string, unknown>) => logger.info(data ?? {}, message),
        warn: (message: string, data?: Record<string, unknown>) => logger.warn(data ?? {}, message),
        error: (message: string, data?: Record<string, unknown>) => logger.error(data ?? {}, message),
      };

      logger.info({
        port,
        host,
        workerTimeout,
        authEnabled: !!(authToken || process.env['ORCHESTRATOR_TOKEN']),
        redisUrl: redisUrl ? redisUrl.replace(/\/\/.*@/, '//***@') : undefined,
      }, 'Starting orchestrator server');

      // Create job queue (Redis if URL provided, in-memory fallback)
      const jobQueue = await createJobQueue(redisUrl, loggerAdapter);

      // Create server with pino logger adapter
      const server = createOrchestratorServer({
        port,
        host,
        workerTimeout,
        authToken,
        jobQueue,
        logger: loggerAdapter,
      });

      // Label monitor setup
      const labelMonitorEnabled =
        options['labelMonitor'] === true ||
        process.env['LABEL_MONITOR_ENABLED'] === 'true';

      let labelMonitorSetup: Awaited<ReturnType<typeof setupLabelMonitor>> | null = null;

      if (labelMonitorEnabled) {
        labelMonitorSetup = await setupLabelMonitor(options, redisUrl, server, loggerAdapter, logger);
      }

      // Graceful shutdown handler
      let isShuttingDown = false;
      const shutdown = async (signal: string) => {
        if (isShuttingDown) {
          return;
        }
        isShuttingDown = true;

        logger.info({ signal }, 'Received shutdown signal, stopping orchestrator...');

        try {
          // Stop label monitor and smee receiver before closing the server
          if (labelMonitorSetup) {
            labelMonitorSetup.monitor.stopPolling();
            if (labelMonitorSetup.smeeReceiver) {
              labelMonitorSetup.smeeReceiver.stop();
            }
            logger.info('Label monitor stopped');
          }

          // Give a brief grace period for in-flight requests
          await new Promise(resolve => setTimeout(resolve, 1000));

          await server.close();
          logger.info('Orchestrator shutdown complete');
          process.exit(0);
        } catch (error) {
          logger.error({ error: String(error) }, 'Error during shutdown');
          process.exit(1);
        }
      };

      // Handle signals
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));

      // Handle uncaught errors
      process.on('uncaughtException', (error) => {
        logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
        shutdown('uncaughtException');
      });

      process.on('unhandledRejection', (reason) => {
        logger.error({ reason: String(reason) }, 'Unhandled rejection');
        shutdown('unhandledRejection');
      });

      // Start the server
      try {
        await server.listen();
        logger.info({
          port: server.getPort(),
          host,
          labelMonitor: labelMonitorEnabled,
          endpoints: [
            'GET  /api/health',
            'POST /api/workers/register',
            'DELETE /api/workers/:workerId',
            'POST /api/workers/:workerId/heartbeat',
            'GET  /api/jobs/poll',
            'GET  /api/jobs/:jobId',
            'PUT  /api/jobs/:jobId/status',
            'POST /api/jobs/:jobId/result',
            'POST /api/jobs/:jobId/cancel',
          ],
        }, 'Orchestrator server ready and listening');

        // Start label monitoring after server is ready
        if (labelMonitorSetup) {
          // Start smee receiver for real-time webhook events (if configured)
          if (labelMonitorSetup.smeeReceiver) {
            labelMonitorSetup.smeeReceiver.start().catch((error: unknown) => {
              logger.error({ error: String(error) }, 'Smee webhook receiver failed');
            });
            logger.info('Smee webhook receiver started');
          }

          // Start polling as primary (no smee) or fallback (with smee)
          labelMonitorSetup.monitor.startPolling().catch((error: unknown) => {
            logger.error({ error: String(error) }, 'Label monitor polling failed');
          });
          logger.info(
            { mode: labelMonitorSetup.smeeReceiver ? 'smee+polling-fallback' : 'polling-only' },
            'Label monitor started',
          );
        }
      } catch (error) {
        logger.error({ error: String(error) }, 'Failed to start orchestrator server');
        process.exit(1);
      }
    });

  return command;
}

/**
 * Default poll interval when smee.io webhooks are active.
 * Polling serves as a fallback only, so it can be very infrequent.
 */
const SMEE_FALLBACK_POLL_INTERVAL_MS = 300_000; // 5 minutes

/**
 * Setup label monitoring when enabled.
 * Dynamically imports orchestrator services to avoid loading them when disabled.
 * Returns both the monitor service and an optional smee receiver.
 */
async function setupLabelMonitor(
  options: Record<string, unknown>,
  redisUrl: string | undefined,
  server: ReturnType<typeof createOrchestratorServer>,
  loggerAdapter: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void; error: (msg: string, data?: Record<string, unknown>) => void },
  logger: ReturnType<typeof getLogger>,
) {
  // Dynamic import to avoid loading orchestrator deps when label monitor is disabled
  const { LabelMonitorService, SmeeWebhookReceiver, PhaseTrackerService } = await import('@generacy-ai/orchestrator');
  const { createGitHubClient } = await import('@generacy-ai/workflow-engine');
  const { Redis: IORedis } = await import('ioredis');

  // Parse repositories
  const reposStr =
    (options['monitoredRepos'] as string | undefined) ??
    process.env['MONITORED_REPOS'] ?? '';

  const repositories = reposStr
    .split(',')
    .map(r => r.trim())
    .filter(Boolean)
    .map(r => {
      const [owner, repo] = r.split('/');
      if (!owner || !repo) {
        logger.warn({ repo: r }, 'Invalid repository format, expected owner/repo');
        return null;
      }
      return { owner, repo };
    })
    .filter((r): r is { owner: string; repo: string } => r !== null);

  if (repositories.length === 0) {
    logger.error('Label monitor enabled but no valid repositories configured. Set MONITORED_REPOS.');
    process.exit(1);
  }

  // Check for smee.io channel URL
  const smeeChannelUrl = process.env['SMEE_CHANNEL_URL'];
  const useSmee = !!smeeChannelUrl;

  // When smee is active, polling is just a fallback — use a much longer interval
  const configuredPollMs = parseInt(
    (options['pollInterval'] as string | undefined) ??
    process.env['POLL_INTERVAL_MS'] ?? '30000',
    10,
  );
  const pollIntervalMs = useSmee ? SMEE_FALLBACK_POLL_INTERVAL_MS : configuredPollMs;

  // Create Redis connection for phase tracker (reuse URL from job queue)
  let phaseTrackerRedis: InstanceType<typeof IORedis> | null = null;
  if (redisUrl) {
    try {
      phaseTrackerRedis = new IORedis(redisUrl);
      await phaseTrackerRedis.ping();
      logger.info('Phase tracker Redis connected');
    } catch (error) {
      logger.warn(
        { error: String(error) },
        'Failed to connect Redis for phase tracker, dedup will be disabled',
      );
      phaseTrackerRedis = null;
    }
  }

  // Pino-compatible logger adapter for LabelMonitorService
  // The service calls logger.info(obj, msg) or logger.info(msg)
  const monitorLogger = {
    info: (msgOrObj: string | Record<string, unknown>, msg?: string) => {
      if (typeof msgOrObj === 'string') {
        logger.info(msgOrObj);
      } else {
        logger.info(msgOrObj, msg ?? '');
      }
    },
    warn: (msgOrObj: string | Record<string, unknown>, msg?: string) => {
      if (typeof msgOrObj === 'string') {
        logger.warn(msgOrObj);
      } else {
        logger.warn(msgOrObj, msg ?? '');
      }
    },
    error: (msgOrObj: string | Record<string, unknown>, msg?: string) => {
      if (typeof msgOrObj === 'string') {
        logger.error(msgOrObj);
      } else {
        logger.error(msgOrObj, msg ?? '');
      }
    },
  };

  const phaseTracker = new PhaseTrackerService(monitorLogger, phaseTrackerRedis);
  const bridge = new LabelMonitorBridge(server, createGitHubClient, loggerAdapter);

  const monitor = new LabelMonitorService(
    monitorLogger,
    createGitHubClient,
    phaseTracker,
    bridge,
    { pollIntervalMs, maxConcurrentPolls: 5, adaptivePolling: !useSmee },
    repositories,
  );

  // Create smee receiver if channel URL is configured
  let smeeReceiver: InstanceType<typeof SmeeWebhookReceiver> | null = null;
  if (useSmee) {
    const watchedRepos = new Set(repositories.map(r => `${r.owner}/${r.repo}`));
    smeeReceiver = new SmeeWebhookReceiver(monitorLogger, monitor, {
      channelUrl: smeeChannelUrl,
      watchedRepos,
    });
    logger.info(
      { channelUrl: smeeChannelUrl, pollFallbackMs: pollIntervalMs },
      'Smee.io webhook receiver configured (polling reduced to fallback)',
    );
  }

  logger.info(
    { repositories: repositories.length, pollIntervalMs, smee: useSmee },
    'Label monitor configured',
  );

  return { monitor, smeeReceiver };
}
