import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type OrchestratorConfig, validateConfig } from './schema.js';
import { tryLoadWorkspaceConfig, tryLoadOrchestratorSettings, tryLoadDefaultsRole, getMonitoredRepos, findWorkspaceConfigPath } from '@generacy-ai/config';

/**
 * Environment variable prefix for configuration
 */
const ENV_PREFIX = 'ORCHESTRATOR_';

/**
 * Default configuration file paths to search
 */
const DEFAULT_CONFIG_PATHS = [
  './orchestrator.yaml',
  './orchestrator.yml',
  './config/orchestrator.yaml',
  './config/orchestrator.yml',
];

/**
 * Load configuration from environment variables
 */
function loadFromEnv(): Record<string, unknown> {
  const config: Record<string, unknown> = {
    server: {},
    redis: {},
    auth: {
      jwt: {},
      github: {},
    },
    rateLimit: {},
    cors: {},
    logging: {},
    repositories: undefined,
  };

  // Server config
  if (process.env[`${ENV_PREFIX}PORT`]) {
    (config.server as Record<string, unknown>).port = parseInt(
      process.env[`${ENV_PREFIX}PORT`]!,
      10
    );
  }
  if (process.env[`${ENV_PREFIX}HOST`]) {
    (config.server as Record<string, unknown>).host = process.env[`${ENV_PREFIX}HOST`];
  }

  // Redis config (REDIS_URL takes precedence, falls back to ORCHESTRATOR_REDIS_URL)
  const redisUrl = process.env['REDIS_URL'] ?? process.env[`${ENV_PREFIX}REDIS_URL`];
  if (redisUrl) {
    (config.redis as Record<string, unknown>).url = redisUrl;
  }

  // Auth config
  if (process.env[`${ENV_PREFIX}AUTH_ENABLED`]) {
    (config.auth as Record<string, unknown>).enabled =
      process.env[`${ENV_PREFIX}AUTH_ENABLED`] === 'true';
  }
  if (process.env[`${ENV_PREFIX}JWT_SECRET`]) {
    ((config.auth as Record<string, unknown>).jwt as Record<string, unknown>).secret =
      process.env[`${ENV_PREFIX}JWT_SECRET`];
  }
  if (process.env[`${ENV_PREFIX}JWT_EXPIRES_IN`]) {
    ((config.auth as Record<string, unknown>).jwt as Record<string, unknown>).expiresIn =
      process.env[`${ENV_PREFIX}JWT_EXPIRES_IN`];
  }
  if (process.env['GITHUB_CLIENT_ID']) {
    ((config.auth as Record<string, unknown>).github as Record<string, unknown>).clientId =
      process.env['GITHUB_CLIENT_ID'];
  }
  if (process.env['GITHUB_CLIENT_SECRET']) {
    ((config.auth as Record<string, unknown>).github as Record<string, unknown>).clientSecret =
      process.env['GITHUB_CLIENT_SECRET'];
  }
  if (process.env[`${ENV_PREFIX}GITHUB_CALLBACK_URL`]) {
    ((config.auth as Record<string, unknown>).github as Record<string, unknown>).callbackUrl =
      process.env[`${ENV_PREFIX}GITHUB_CALLBACK_URL`];
  }

  // Rate limit config
  if (process.env[`${ENV_PREFIX}RATE_LIMIT_ENABLED`]) {
    (config.rateLimit as Record<string, unknown>).enabled =
      process.env[`${ENV_PREFIX}RATE_LIMIT_ENABLED`] === 'true';
  }
  if (process.env[`${ENV_PREFIX}RATE_LIMIT_MAX`]) {
    (config.rateLimit as Record<string, unknown>).max = parseInt(
      process.env[`${ENV_PREFIX}RATE_LIMIT_MAX`]!,
      10
    );
  }
  if (process.env[`${ENV_PREFIX}RATE_LIMIT_WINDOW`]) {
    (config.rateLimit as Record<string, unknown>).timeWindow =
      process.env[`${ENV_PREFIX}RATE_LIMIT_WINDOW`];
  }

  // Logging config (LOG_LEVEL takes precedence, falls back to ORCHESTRATOR_LOG_LEVEL)
  const logLevel = process.env['LOG_LEVEL'] ?? process.env[`${ENV_PREFIX}LOG_LEVEL`];
  if (logLevel) {
    (config.logging as Record<string, unknown>).level = logLevel;
  }
  if (process.env[`${ENV_PREFIX}LOG_PRETTY`]) {
    (config.logging as Record<string, unknown>).pretty =
      process.env[`${ENV_PREFIX}LOG_PRETTY`] === 'true';
  }

  // Repositories config (MONITORED_REPOS takes precedence, falls back to ORCHESTRATOR_REPOSITORIES, then config file)
  const reposStr = process.env['MONITORED_REPOS'] ?? process.env[`${ENV_PREFIX}REPOSITORIES`];
  const configPath = findWorkspaceConfigPath(process.cwd());
  if (reposStr) {
    const repos = reposStr.split(',').map(r => {
      const [owner, repo] = r.trim().split('/');
      return { owner, repo };
    }).filter(r => r.owner && r.repo);
    config.repositories = repos;
  } else {
    // Fallback to .generacy/config.yaml workspace config
    if (configPath) {
      const workspaceConfig = tryLoadWorkspaceConfig(configPath);
      if (workspaceConfig) {
        config.repositories = getMonitoredRepos(workspaceConfig);
      }
    }
  }

  // Fallback: read orchestrator settings from .generacy/config.yaml
  const orchSettings = configPath ? tryLoadOrchestratorSettings(configPath) : null;
  if (orchSettings) {
    if (!config.labelMonitor && orchSettings.labelMonitor !== undefined) {
      config.labelMonitor = orchSettings.labelMonitor;
    }
    const smeeEnvUrl = process.env['SMEE_CHANNEL_URL'] ?? process.env[`${ENV_PREFIX}SMEE_CHANNEL_URL`];
    if (orchSettings.smeeChannelUrl && !smeeEnvUrl) {
      config.smee = { channelUrl: orchSettings.smeeChannelUrl };
    }
    if (orchSettings.webhookSetup !== undefined &&
        !process.env['WEBHOOK_SETUP_ENABLED'] && !process.env[`${ENV_PREFIX}WEBHOOK_SETUP_ENABLED`]) {
      config.webhookSetup = { enabled: orchSettings.webhookSetup };
    }
  }

  // Monitor config (POLL_INTERVAL_MS takes precedence, falls back to ORCHESTRATOR_POLL_INTERVAL_MS)
  const pollIntervalMs = process.env['POLL_INTERVAL_MS'] ?? process.env[`${ENV_PREFIX}POLL_INTERVAL_MS`];
  if (pollIntervalMs) {
    if (!config.monitor) {
      config.monitor = {};
    }
    (config.monitor as Record<string, unknown>).pollIntervalMs = parseInt(pollIntervalMs, 10);
  }

  // Webhook secret (WEBHOOK_SECRET takes precedence, falls back to ORCHESTRATOR_WEBHOOK_SECRET)
  const webhookSecret = process.env['WEBHOOK_SECRET'] ?? process.env[`${ENV_PREFIX}WEBHOOK_SECRET`];
  if (webhookSecret) {
    if (!config.monitor) {
      config.monitor = {};
    }
    (config.monitor as Record<string, unknown>).webhookSecret = webhookSecret;
  }

  // Cluster GitHub username for assignee-based issue filtering
  const clusterGithubUsername = process.env['CLUSTER_GITHUB_USERNAME'];
  if (clusterGithubUsername) {
    if (!config.monitor) {
      config.monitor = {};
    }
    (config.monitor as Record<string, unknown>).clusterGithubUsername = clusterGithubUsername;
  }

  // PR Monitor config
  if (process.env['PR_MONITOR_ENABLED']) {
    if (!config.prMonitor) {
      config.prMonitor = {};
    }
    (config.prMonitor as Record<string, unknown>).enabled =
      process.env['PR_MONITOR_ENABLED'] === 'true';
  }
  if (process.env['PR_MONITOR_POLL_INTERVAL_MS']) {
    if (!config.prMonitor) {
      config.prMonitor = {};
    }
    (config.prMonitor as Record<string, unknown>).pollIntervalMs = parseInt(
      process.env['PR_MONITOR_POLL_INTERVAL_MS']!,
      10
    );
  }
  if (process.env['PR_MONITOR_WEBHOOK_SECRET']) {
    if (!config.prMonitor) {
      config.prMonitor = {};
    }
    (config.prMonitor as Record<string, unknown>).webhookSecret =
      process.env['PR_MONITOR_WEBHOOK_SECRET'];
  }
  if (process.env['PR_MONITOR_ADAPTIVE_POLLING']) {
    if (!config.prMonitor) {
      config.prMonitor = {};
    }
    (config.prMonitor as Record<string, unknown>).adaptivePolling =
      process.env['PR_MONITOR_ADAPTIVE_POLLING'] === 'true';
  }
  if (process.env['PR_MONITOR_MAX_CONCURRENT_POLLS']) {
    if (!config.prMonitor) {
      config.prMonitor = {};
    }
    (config.prMonitor as Record<string, unknown>).maxConcurrentPolls = parseInt(
      process.env['PR_MONITOR_MAX_CONCURRENT_POLLS']!,
      10
    );
  }

  // Worker config
  const workerWorkspaceDir = process.env['WORKER_WORKSPACE_DIR'] ?? process.env[`${ENV_PREFIX}WORKER_WORKSPACE_DIR`];
  if (workerWorkspaceDir) {
    if (!config.worker) {
      config.worker = {};
    }
    (config.worker as Record<string, unknown>).workspaceDir = workerWorkspaceDir;
  }

  // Credential role: env var overrides config file
  const credentialRole = process.env['GENERACY_CREDENTIAL_ROLE']
    ?? (configPath ? tryLoadDefaultsRole(configPath) : null);
  if (credentialRole) {
    if (!config.worker) {
      config.worker = {};
    }
    (config.worker as Record<string, unknown>).credentialRole = credentialRole;
  }

  // Smee config (SMEE_CHANNEL_URL takes precedence, falls back to ORCHESTRATOR_SMEE_CHANNEL_URL)
  const smeeChannelUrl = process.env['SMEE_CHANNEL_URL'] ?? process.env[`${ENV_PREFIX}SMEE_CHANNEL_URL`];
  if (smeeChannelUrl) {
    if (!config.smee) {
      config.smee = {};
    }
    (config.smee as Record<string, unknown>).channelUrl = smeeChannelUrl;
  }

  // Label monitor config (LABEL_MONITOR_ENABLED takes precedence, falls back to ORCHESTRATOR_LABEL_MONITOR_ENABLED)
  const labelMonitorEnabled = process.env['LABEL_MONITOR_ENABLED'] ?? process.env[`${ENV_PREFIX}LABEL_MONITOR_ENABLED`];
  if (labelMonitorEnabled !== undefined) {
    config.labelMonitor = labelMonitorEnabled === 'true';
  }

  // Activation config (GENERACY_API_URL for device-code flow — required in orchestrator context)
  const activationCloudUrl = process.env['GENERACY_API_URL'];
  if (activationCloudUrl) {
    if (!config.activation) {
      config.activation = {};
    }
    (config.activation as Record<string, unknown>).cloudUrl = activationCloudUrl;
  }
  const activationKeyFile = process.env['GENERACY_KEY_FILE_PATH'];
  if (activationKeyFile) {
    if (!config.activation) {
      config.activation = {};
    }
    (config.activation as Record<string, unknown>).keyFilePath = activationKeyFile;
  }

  // Relay config (GENERACY_API_KEY for cloud connectivity)
  const relayApiKey = process.env['GENERACY_API_KEY'];
  let relayCloudUrl = process.env['GENERACY_RELAY_URL'];

  // Derive relay URL from GENERACY_CHANNEL when GENERACY_RELAY_URL is not set
  if (!relayCloudUrl) {
    const channel = process.env['GENERACY_CHANNEL'] ?? 'stable';
    const relayHost = channel === 'preview' ? 'api-staging.generacy.ai' : 'api.generacy.ai';
    relayCloudUrl = `wss://${relayHost}/relay`;
  }

  if (relayApiKey || relayCloudUrl) {
    if (!config.relay) {
      config.relay = {};
    }
    if (relayApiKey) {
      (config.relay as Record<string, unknown>).apiKey = relayApiKey;
    }
    if (relayCloudUrl) {
      (config.relay as Record<string, unknown>).cloudUrl = relayCloudUrl;
    }
  }

  // Webhook setup config
  if (process.env[`${ENV_PREFIX}WEBHOOK_SETUP_ENABLED`] || process.env['WEBHOOK_SETUP_ENABLED']) {
    const value = process.env['WEBHOOK_SETUP_ENABLED'] ?? process.env[`${ENV_PREFIX}WEBHOOK_SETUP_ENABLED`];
    if (!config.webhookSetup) {
      config.webhookSetup = {};
    }
    (config.webhookSetup as Record<string, unknown>).enabled = value === 'true';
  }

  return config;
}

/**
 * Load configuration from a YAML file
 */
function loadFromFile(filePath: string): Record<string, unknown> {
  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Configuration file not found: ${absolutePath}`);
  }

  const content = readFileSync(absolutePath, 'utf-8');
  const parsed = parseYaml(content) as Record<string, unknown>;

  // Return the orchestrator section if present, otherwise the whole config
  return (parsed.orchestrator as Record<string, unknown>) || parsed;
}

/**
 * Find the first existing config file from default paths
 */
function findConfigFile(): string | null {
  for (const configPath of DEFAULT_CONFIG_PATHS) {
    if (existsSync(resolve(configPath))) {
      return configPath;
    }
  }
  return null;
}

/**
 * Deep merge two objects (env overrides file)
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = result[key];

    if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
      continue;
    }

    if (
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Remove empty nested objects
 */
function removeEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const cleaned = removeEmpty(value as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) {
        result[key] = cleaned;
      }
    } else if (value !== undefined && value !== null && value !== '') {
      result[key] = value;
    }
  }

  return result;
}

export interface LoadConfigOptions {
  /** Path to configuration file (optional, will search defaults if not provided) */
  configFile?: string;
  /** Whether to load from environment variables (default: true) */
  loadEnv?: boolean;
}

/**
 * Load configuration from file and environment variables
 *
 * Priority (highest to lowest):
 * 1. Environment variables
 * 2. Configuration file (specified or found)
 * 3. Default values
 */
export function loadConfig(options: LoadConfigOptions = {}): OrchestratorConfig {
  const { configFile, loadEnv = true } = options;

  let fileConfig: Record<string, unknown> = {};

  // Load from file if specified or found
  const configPath = configFile || findConfigFile();
  if (configPath) {
    try {
      fileConfig = loadFromFile(configPath);
    } catch (error) {
      if (configFile) {
        // If explicitly specified, throw the error
        throw error;
      }
      // Otherwise, continue without file config
    }
  }

  // Load from environment
  let envConfig: Record<string, unknown> = {};
  if (loadEnv) {
    envConfig = removeEmpty(loadFromEnv());
  }

  // Merge configs (env overrides file)
  const mergedConfig = deepMerge(fileConfig, envConfig);

  // Validate and return
  const config = validateConfig(mergedConfig);

  // Auto-populate conversations.workspaces from repositories when empty.
  // Maps each repo "owner/name" → "/workspaces/name" if the directory exists.
  if (Object.keys(config.conversations.workspaces).length === 0 && config.repositories.length > 0) {
    for (const repo of config.repositories) {
      const repoKey = `${repo.owner}/${repo.repo}`;
      const workspacePath = `/workspaces/${repo.repo}`;
      if (existsSync(workspacePath)) {
        config.conversations.workspaces[repoKey] = workspacePath;
      }
    }
  }

  return config;
}

/**
 * Create a minimal config for testing
 */
export function createTestConfig(
  overrides: Partial<OrchestratorConfig> = {}
): OrchestratorConfig {
  return validateConfig({
    server: {
      port: 0, // Random port
      host: '127.0.0.1',
    },
    redis: {
      url: 'redis://127.0.0.1:1', // Unreachable port — triggers fast failure and in-memory fallback
    },
    auth: {
      enabled: false,
      providers: [],
      jwt: {
        secret: 'test-secret-at-least-32-characters-long',
        expiresIn: '1h',
      },
    },
    rateLimit: {
      enabled: false,
    },
    cors: {
      origin: true,
      credentials: true,
    },
    logging: {
      level: 'error',
      pretty: false,
    },
    ...overrides,
  });
}
