/**
 * Worker command implementation.
 * Connects to orchestrator and processes jobs.
 */
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getLogger, createWorkflowLogger } from '../utils/logger.js';
import { createConfig } from '../utils/config.js';
import {
  OrchestratorClient,
  OrchestratorClientError,
  HeartbeatManager,
  JobHandler,
  type WorkerRegistration,
} from '../../orchestrator/index.js';
import { HumancyApiDecisionHandler, type HumanDecisionHandler } from '@generacy-ai/workflow-engine';
import { createHealthServer } from '../../health/server.js';

/**
 * Create the worker command
 */
export function workerCommand(): Command {
  const command = new Command('worker');

  command
    .description('Start a worker that processes jobs from the orchestrator')
    .option('-u, --url <url>', 'Orchestrator URL', process.env['ORCHESTRATOR_URL'])
    .option('-i, --worker-id <id>', 'Worker ID (auto-generated if not provided)')
    .option('-n, --worker-name <name>', 'Worker name', `worker-${hostname()}`)
    .option('-c, --capabilities <caps...>', 'Worker capabilities/tags', [])
    .option('-w, --workdir <path>', 'Working directory for job execution', process.cwd())
    .option('-p, --health-port <port>', 'Health check port', '8080')
    .option('--heartbeat-interval <ms>', 'Heartbeat interval in milliseconds', '30000')
    .option('--poll-interval <ms>', 'Job poll interval in milliseconds', '5000')
    .option('--max-concurrent <n>', 'Maximum concurrent jobs', '1')
    .action(async (options) => {
      const logger = getLogger();

      // Validate required options
      if (!options['url']) {
        logger.error('Orchestrator URL is required. Set ORCHESTRATOR_URL env var or use --url option');
        process.exit(1);
      }

      // Create configuration
      const config = createConfig({
        orchestratorUrl: options['url'],
        workerId: options['workerId'],
        workdir: options['workdir'],
        healthPort: parseInt(options['healthPort'], 10),
        heartbeatInterval: parseInt(options['heartbeatInterval'], 10),
        pollInterval: parseInt(options['pollInterval'], 10),
      });

      const workerId = config.workerId ?? randomUUID();
      const workerName = options['workerName'] ?? `worker-${hostname()}`;
      const capabilities: string[] = options['capabilities'] ?? [];

      logger.info({ workerId, workerName, capabilities }, 'Starting worker');

      // Create orchestrator client
      const client = new OrchestratorClient({
        baseUrl: config.orchestratorUrl!,
      });

      // Register worker
      const registration: WorkerRegistration = {
        id: workerId,
        name: workerName,
        capabilities,
        maxConcurrent: parseInt(options['maxConcurrent'], 10),
        healthEndpoint: `http://localhost:${config.healthPort}/health`,
      };

      try {
        await client.register(registration);
        logger.info({ workerId }, 'Worker registered with orchestrator');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ error: msg }, 'Failed to register worker');
        process.exit(1);
      }

      // Re-registration helper for when the orchestrator drops us
      let isReregistering = false;
      const reregister = async () => {
        if (isReregistering) return;
        isReregistering = true;
        try {
          logger.info({ workerId }, 'Worker not found in orchestrator, re-registering...');
          await client.register(registration);
          logger.info({ workerId }, 'Worker re-registered with orchestrator');
        } catch (regError) {
          const msg = regError instanceof Error ? regError.message : String(regError);
          logger.error({ error: msg }, 'Re-registration failed');
        } finally {
          isReregistering = false;
        }
      };

      // Helper to detect WORKER_NOT_FOUND errors
      const isWorkerNotFound = (error: Error): boolean =>
        error instanceof OrchestratorClientError && error.code === 'WORKER_NOT_FOUND';

      // Create heartbeat manager
      const heartbeatManager = new HeartbeatManager({
        client,
        workerId,
        interval: config.heartbeatInterval,
        onCommand: (cmd) => {
          logger.info({ command: cmd }, 'Received command from orchestrator');
          if (cmd.type === 'shutdown') {
            logger.info('Shutdown requested by orchestrator');
            shutdown();
          } else if (cmd.type === 'cancel') {
            logger.info('Cancel requested by orchestrator');
            jobHandler.cancelCurrentJob();
          }
        },
        onError: (error) => {
          logger.warn({ error: error.message }, 'Heartbeat failed');
          if (isWorkerNotFound(error)) {
            reregister();
          }
        },
      });

      // Create Humancy API decision handler if configured
      const humancyApiUrl = process.env['HUMANCY_API_URL'];
      let humanDecisionHandler: HumanDecisionHandler | undefined;
      if (humancyApiUrl) {
        const humancyAgentId = process.env['HUMANCY_AGENT_ID'] ?? workerId;
        const humancyAuthToken = process.env['HUMANCY_AUTH_TOKEN'] ?? process.env['ORCHESTRATOR_TOKEN'];
        humanDecisionHandler = new HumancyApiDecisionHandler({
          apiUrl: humancyApiUrl,
          agentId: humancyAgentId,
          authToken: humancyAuthToken,
          fallbackToSimulation: true,
        });
        logger.info({ humancyApiUrl, humancyAgentId }, 'Humancy API decision handler configured');
      }

      // Create job handler
      const workflowLogger = createWorkflowLogger(logger);
      const jobHandler = new JobHandler({
        client,
        workerId,
        pollInterval: config.pollInterval,
        logger: workflowLogger,
        workdir: config.workdir,
        capabilities,
        humanDecisionHandler,
        onJobStart: (job) => {
          logger.info({ jobId: job.id, jobName: job.name }, 'Job started');
          heartbeatManager.setStatus('busy');
          heartbeatManager.setCurrentJob(job.id);
        },
        onJobComplete: (job, result) => {
          logger.info({ jobId: job.id, status: result.status }, 'Job completed');
          heartbeatManager.setStatus('idle');
          heartbeatManager.setCurrentJob(undefined);
        },
        onError: (error, job) => {
          logger.error({ error: error.message, jobId: job?.id }, 'Job error');
          if (isWorkerNotFound(error)) {
            reregister();
          }
        },
      });

      // Create health server
      const healthServer = createHealthServer({
        port: config.healthPort,
        getStatus: () => ({
          status: jobHandler.isBusy() ? 'busy' : 'healthy',
          uptime: heartbeatManager.getUptime(),
          lastHeartbeat: heartbeatManager.getLastHeartbeat()?.toISOString(),
          currentJob: jobHandler.getCurrentJob()?.id,
        }),
      });

      // Graceful shutdown handler
      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) {
          return;
        }
        isShuttingDown = true;

        logger.info('Shutting down worker...');
        heartbeatManager.setStatus('stopping');

        // Stop accepting new jobs
        jobHandler.stop();

        // Wait for current job to finish (with timeout)
        const shutdownTimeout = 60000; // 1 minute
        const startTime = Date.now();

        while (jobHandler.isBusy() && Date.now() - startTime < shutdownTimeout) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Force cancel if still running
        if (jobHandler.isBusy()) {
          logger.warn('Shutdown timeout reached, cancelling current job');
          jobHandler.cancelCurrentJob();
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // Stop heartbeat
        heartbeatManager.stop();

        // Unregister from orchestrator
        try {
          await client.unregister(workerId);
          logger.info('Worker unregistered from orchestrator');
        } catch (error) {
          logger.warn({ error }, 'Failed to unregister worker');
        }

        // Close health server
        healthServer.close();

        logger.info('Worker shutdown complete');
        process.exit(0);
      };

      // Handle signals
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);

      // Start services
      heartbeatManager.start();
      jobHandler.start();
      healthServer.listen();

      logger.info({
        workerId,
        orchestratorUrl: config.orchestratorUrl,
        healthPort: config.healthPort,
      }, 'Worker started and ready to process jobs');
    });

  return command;
}
