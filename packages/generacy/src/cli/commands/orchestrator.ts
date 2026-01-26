/**
 * Orchestrator command implementation.
 * Starts the orchestrator HTTP server for worker coordination.
 */
import { Command } from 'commander';
import { getLogger } from '../utils/logger.js';
import { createOrchestratorServer } from '../../orchestrator/index.js';

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
    .action(async (options) => {
      const logger = getLogger();

      const port = parseInt(options['port'], 10);
      const host = options['host'] as string;
      const workerTimeout = parseInt(options['workerTimeout'], 10);
      const authToken = options['authToken'] as string | undefined;

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

      logger.info({
        port,
        host,
        workerTimeout,
        authEnabled: !!(authToken || process.env['ORCHESTRATOR_TOKEN']),
      }, 'Starting orchestrator server');

      // Create server with pino logger adapter
      const server = createOrchestratorServer({
        port,
        host,
        workerTimeout,
        authToken,
        logger: {
          info: (message: string, data?: Record<string, unknown>) => logger.info(data ?? {}, message),
          warn: (message: string, data?: Record<string, unknown>) => logger.warn(data ?? {}, message),
          error: (message: string, data?: Record<string, unknown>) => logger.error(data ?? {}, message),
        },
      });

      // Graceful shutdown handler
      let isShuttingDown = false;
      const shutdown = async (signal: string) => {
        if (isShuttingDown) {
          return;
        }
        isShuttingDown = true;

        logger.info({ signal }, 'Received shutdown signal, stopping orchestrator...');

        try {
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
      } catch (error) {
        logger.error({ error: String(error) }, 'Failed to start orchestrator server');
        process.exit(1);
      }
    });

  return command;
}
