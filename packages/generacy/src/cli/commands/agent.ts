/**
 * Agent command implementation.
 * Extends worker with Agency integration for tool routing.
 */
import { Command } from 'commander';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getLogger, createWorkflowLogger } from '../utils/logger.js';
import { createConfig } from '../utils/config.js';
import {
  OrchestratorClient,
  HeartbeatManager,
  JobHandler,
  type WorkerRegistration,
} from '../../orchestrator/index.js';
import { createHealthServer } from '../../health/server.js';
import { createAgencyConnection, type AgencyConnection } from '../../agency/index.js';

/**
 * Create the agent command
 */
export function agentCommand(): Command {
  const command = new Command('agent');

  command
    .description('Start an agent worker with Agency integration for AI tool routing')
    .option('-u, --url <url>', 'Orchestrator URL', process.env['ORCHESTRATOR_URL'])
    .option('-i, --worker-id <id>', 'Worker ID (auto-generated if not provided)')
    .option('-n, --worker-name <name>', 'Worker name', `agent-${hostname()}`)
    .option('-c, --capabilities <caps...>', 'Worker capabilities/tags', ['agent', 'ai'])
    .option('-w, --workdir <path>', 'Working directory for job execution', process.cwd())
    .option('-p, --health-port <port>', 'Health check port', '8080')
    .option('--heartbeat-interval <ms>', 'Heartbeat interval in milliseconds', '30000')
    .option('--poll-interval <ms>', 'Job poll interval in milliseconds', '5000')
    .option('--agency-mode <mode>', 'Agency mode: subprocess or network', 'subprocess')
    .option('--agency-url <url>', 'Agency URL for network mode', process.env['AGENCY_URL'])
    .option('--agency-command <cmd>', 'Agency command for subprocess mode', 'npx @anthropic-ai/agency')
    .action(async (options) => {
      const logger = getLogger();
      const workflowLogger = createWorkflowLogger(logger);

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
        agencyMode: options['agencyMode'],
        agencyUrl: options['agencyUrl'],
        agencyCommand: options['agencyCommand'],
      });

      const workerId = config.workerId ?? randomUUID();
      const workerName = options['workerName'] ?? `agent-${hostname()}`;
      const capabilities: string[] = options['capabilities'] ?? ['agent', 'ai'];

      logger.info({ workerId, workerName, capabilities, agencyMode: config.agencyMode }, 'Starting agent worker');

      // Create agency connection
      let agency: AgencyConnection | null = null;
      try {
        agency = await createAgencyConnection({
          mode: config.agencyMode,
          url: config.agencyUrl,
          command: config.agencyCommand,
          logger: workflowLogger,
        });
        await agency.connect();
        logger.info('Agency connected');

        // List available tools
        const tools = await agency.listTools();
        logger.info({ tools }, 'Available agency tools');
      } catch (error) {
        logger.error({ error }, 'Failed to connect to agency');
        process.exit(1);
      }

      // Create orchestrator client
      const client = new OrchestratorClient({
        baseUrl: config.orchestratorUrl!,
      });

      // Register worker
      const registration: WorkerRegistration = {
        id: workerId,
        name: workerName,
        capabilities,
        maxConcurrent: 1,
        healthEndpoint: `http://localhost:${config.healthPort}/health`,
        metadata: {
          agencyMode: config.agencyMode,
          hasAgency: true,
        },
      };

      try {
        await client.register(registration);
        logger.info({ workerId }, 'Agent worker registered with orchestrator');
      } catch (error) {
        logger.error({ error }, 'Failed to register agent worker');
        await agency?.disconnect();
        process.exit(1);
      }

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
        },
      });

      // Create job handler
      const jobHandler = new JobHandler({
        client,
        workerId,
        pollInterval: config.pollInterval,
        logger: workflowLogger,
        workdir: config.workdir,
        capabilities,
        onProgress: (jobId, progress) => {
          heartbeatManager.setCurrentJob(jobId, progress);
        },
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
          metadata: {
            agencyConnected: agency?.isConnected() ?? false,
          },
        }),
      });

      // Graceful shutdown handler
      let isShuttingDown = false;
      const shutdown = async () => {
        if (isShuttingDown) {
          return;
        }
        isShuttingDown = true;

        logger.info('Shutting down agent worker...');
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

        // Disconnect from agency
        try {
          await agency?.disconnect();
          logger.info('Agency disconnected');
        } catch (error) {
          logger.warn({ error }, 'Failed to disconnect from agency');
        }

        // Unregister from orchestrator
        try {
          await client.unregister(workerId);
          logger.info('Agent worker unregistered from orchestrator');
        } catch (error) {
          logger.warn({ error }, 'Failed to unregister agent worker');
        }

        // Close health server
        healthServer.close();

        logger.info('Agent worker shutdown complete');
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
        agencyMode: config.agencyMode,
      }, 'Agent worker started and ready to process jobs');
    });

  return command;
}
