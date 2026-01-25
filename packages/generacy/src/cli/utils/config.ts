/**
 * CLI configuration resolution.
 * Merges defaults, environment variables, and CLI arguments.
 */
import type { LogLevel } from './logger.js';

/**
 * CLI configuration interface
 */
export interface CLIConfig {
  /** Log level */
  logLevel: LogLevel;

  /** Enable pretty logging (colors, formatting) */
  prettyLog: boolean;

  /** Default workflow file path */
  workflowFile?: string;

  /** Working directory for workflow execution */
  workdir: string;

  /** Orchestrator URL for worker mode */
  orchestratorUrl?: string;

  /** Worker ID for registration */
  workerId?: string;

  /** Health check port */
  healthPort: number;

  /** Heartbeat interval in milliseconds */
  heartbeatInterval: number;

  /** Job poll interval in milliseconds */
  pollInterval: number;

  /** Agency mode: 'subprocess' | 'network' */
  agencyMode: 'subprocess' | 'network';

  /** Agency URL for network mode */
  agencyUrl?: string;

  /** Agency command for subprocess mode */
  agencyCommand?: string;
}

/**
 * Default configuration values
 */
const defaults: CLIConfig = {
  logLevel: 'info',
  prettyLog: process.env['NODE_ENV'] !== 'production',
  workdir: process.cwd(),
  healthPort: 8080,
  heartbeatInterval: 30000, // 30 seconds
  pollInterval: 5000, // 5 seconds
  agencyMode: 'subprocess',
};

/**
 * Read configuration from environment variables
 */
function readEnvConfig(): Partial<CLIConfig> {
  const config: Partial<CLIConfig> = {};

  if (process.env['LOG_LEVEL']) {
    config.logLevel = process.env['LOG_LEVEL'] as LogLevel;
  }

  if (process.env['GENERACY_PRETTY_LOG']) {
    config.prettyLog = process.env['GENERACY_PRETTY_LOG'] === 'true';
  }

  if (process.env['GENERACY_WORKFLOW_FILE']) {
    config.workflowFile = process.env['GENERACY_WORKFLOW_FILE'];
  }

  if (process.env['GENERACY_WORKDIR']) {
    config.workdir = process.env['GENERACY_WORKDIR'];
  }

  if (process.env['ORCHESTRATOR_URL']) {
    config.orchestratorUrl = process.env['ORCHESTRATOR_URL'];
  }

  if (process.env['WORKER_ID']) {
    config.workerId = process.env['WORKER_ID'];
  }

  if (process.env['HEALTH_PORT']) {
    const port = parseInt(process.env['HEALTH_PORT'], 10);
    if (!isNaN(port)) {
      config.healthPort = port;
    }
  }

  if (process.env['HEARTBEAT_INTERVAL']) {
    const interval = parseInt(process.env['HEARTBEAT_INTERVAL'], 10);
    if (!isNaN(interval)) {
      config.heartbeatInterval = interval;
    }
  }

  if (process.env['POLL_INTERVAL']) {
    const interval = parseInt(process.env['POLL_INTERVAL'], 10);
    if (!isNaN(interval)) {
      config.pollInterval = interval;
    }
  }

  if (process.env['AGENCY_MODE']) {
    const mode = process.env['AGENCY_MODE'];
    if (mode === 'subprocess' || mode === 'network') {
      config.agencyMode = mode;
    }
  }

  if (process.env['AGENCY_URL']) {
    config.agencyUrl = process.env['AGENCY_URL'];
  }

  if (process.env['AGENCY_COMMAND']) {
    config.agencyCommand = process.env['AGENCY_COMMAND'];
  }

  return config;
}

/**
 * Resolve final configuration by merging sources
 * Priority: CLI args > env vars > defaults
 */
export function resolveConfig(cliArgs: Partial<CLIConfig> = {}): CLIConfig {
  const envConfig = readEnvConfig();

  return {
    ...defaults,
    ...envConfig,
    ...cliArgs,
  };
}

/**
 * Validate configuration
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: CLIConfig): void {
  const validLogLevels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
  if (!validLogLevels.includes(config.logLevel)) {
    throw new Error(`Invalid log level: ${config.logLevel}. Valid levels: ${validLogLevels.join(', ')}`);
  }

  if (config.healthPort < 0 || config.healthPort > 65535) {
    throw new Error(`Invalid health port: ${config.healthPort}. Must be between 0 and 65535`);
  }

  if (config.heartbeatInterval < 1000) {
    throw new Error(`Heartbeat interval too short: ${config.heartbeatInterval}ms. Minimum is 1000ms`);
  }

  if (config.pollInterval < 1000) {
    throw new Error(`Poll interval too short: ${config.pollInterval}ms. Minimum is 1000ms`);
  }

  if (config.agencyMode === 'network' && !config.agencyUrl) {
    throw new Error('Agency URL is required when agency mode is "network"');
  }
}

/**
 * Create and validate configuration
 */
export function createConfig(cliArgs: Partial<CLIConfig> = {}): CLIConfig {
  const config = resolveConfig(cliArgs);
  validateConfig(config);
  return config;
}
