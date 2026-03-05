/**
 * Orchestrator command implementation.
 * Starts the Fastify-based orchestrator server from @generacy-ai/orchestrator.
 * All service lifecycle (label monitoring, Smee webhooks, worker dispatch, etc.)
 * is managed internally by the Fastify server.
 */
import crypto from 'node:crypto';
import { Command } from 'commander';
import {
  createServer,
  startServer,
  loadConfig,
  InMemoryApiKeyStore,
  type OrchestratorConfig,
} from '@generacy-ai/orchestrator';

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
    .option('--shutdown-timeout <ms>', 'Graceful shutdown timeout in milliseconds', '30000')
    .option('--log-level <level>', 'Log level (trace, debug, info, warn, error)', 'info')
    .option('--log-pretty', 'Pretty print logs')
    .option('--worker-only', 'Run in worker-only mode (dispatch jobs only, no monitoring)')
    .action(async (options) => {
      const port = parseInt(options['port'], 10);
      const host = options['host'] as string;
      const workerTimeout = parseInt(options['workerTimeout'], 10);
      const authToken = (options['authToken'] as string | undefined) ?? process.env['ORCHESTRATOR_TOKEN'];
      const shutdownTimeout = parseInt(options['shutdownTimeout'], 10);
      const logLevel = options['logLevel'] as string;
      const logPretty = options['logPretty'] === true;

      // Validate port
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error('Invalid port number. Must be between 1 and 65535.');
        process.exit(1);
      }

      // Validate timeout
      if (isNaN(workerTimeout) || workerTimeout < 1000) {
        console.error('Invalid worker timeout. Must be at least 1000ms.');
        process.exit(1);
      }

      // Validate log level
      const validLogLevels = ['trace', 'debug', 'info', 'warn', 'error'];
      if (!validLogLevels.includes(logLevel)) {
        console.error(`Invalid log level: ${logLevel}. Must be one of: ${validLogLevels.join(', ')}`);
        process.exit(1);
      }

      // Ensure JWT secret is available (generate random for local dev if not configured)
      if (!process.env['ORCHESTRATOR_JWT_SECRET']) {
        process.env['ORCHESTRATOR_JWT_SECRET'] = crypto.randomBytes(32).toString('hex');
      }

      // Load base config from YAML files and environment variables
      let config: OrchestratorConfig;
      try {
        config = loadConfig();
      } catch (error) {
        console.error(
          'Failed to load configuration:',
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }

      // Set operating mode
      if (options['workerOnly']) {
        config.mode = 'worker';
      }

      // Override with CLI flags (highest priority)
      config.server.port = port;
      config.server.host = host;
      config.logging.level = logLevel as OrchestratorConfig['logging']['level'];
      config.logging.pretty = logPretty;
      config.dispatch.heartbeatTtlMs = workerTimeout;
      config.dispatch.shutdownTimeoutMs = shutdownTimeout;

      // Redis URL from CLI flag (env var already handled by loadConfig)
      if (options['redisUrl']) {
        config.redis.url = options['redisUrl'] as string;
      }

      // Poll interval from CLI flag
      if (options['pollInterval']) {
        config.monitor.pollIntervalMs = parseInt(options['pollInterval'] as string, 10);
      }

      // Parse repositories from CLI flag (overrides env-loaded repos)
      if (options['monitoredRepos']) {
        config.repositories = (options['monitoredRepos'] as string)
          .split(',')
          .map(r => r.trim())
          .filter(Boolean)
          .map(r => {
            const [owner, repo] = r.split('/');
            return owner && repo ? { owner, repo } : null;
          })
          .filter((r): r is { owner: string; repo: string } => r !== null);
      }

      // Validate label monitor requirements
      const labelMonitorEnabled =
        options['labelMonitor'] === true ||
        process.env['LABEL_MONITOR_ENABLED'] === 'true';

      if (labelMonitorEnabled && config.repositories.length === 0) {
        console.error(
          'Label monitor enabled but no valid repositories configured. ' +
          'Set MONITORED_REPOS env var or use --monitored-repos flag.',
        );
        process.exit(1);
      }

      // Setup auth with CLI token
      let apiKeyStore: InMemoryApiKeyStore | undefined;
      if (authToken) {
        config.auth.enabled = true;
        apiKeyStore = new InMemoryApiKeyStore();
        apiKeyStore.addKey(authToken, {
          name: 'cli-token',
          scopes: ['admin'],
          createdAt: new Date().toISOString(),
        });
      }

      // Create and start the Fastify server
      try {
        const server = await createServer({ config, apiKeyStore });
        const address = await startServer(server);
        server.log.info(
          { address, mode: config.mode, labelMonitor: config.mode !== 'worker' && config.repositories.length > 0 },
          'Orchestrator server ready',
        );
      } catch (error) {
        console.error(
          'Failed to start orchestrator server:',
          error instanceof Error ? error.message : String(error),
        );
        process.exit(1);
      }
    });

  return command;
}
