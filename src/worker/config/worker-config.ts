/**
 * Worker configuration schema and validation.
 */

import type {
  WorkerConfig,
  HealthConfig,
  HeartbeatConfig,
  HandlersConfig,
  ContainerConfig,
  AgentRetryConfig,
  IntegrationRetryConfig,
} from '../types.js';

/**
 * Default agent retry configuration.
 */
export const DEFAULT_AGENT_RETRY_CONFIG: AgentRetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  retryableErrors: ['RATE_LIMIT', 'NETWORK_ERROR', 'TIMEOUT', 'ECONNRESET'],
};

/**
 * Default integration retry configuration.
 */
export const DEFAULT_INTEGRATION_RETRY_CONFIG: IntegrationRetryConfig = {
  maxRetries: 3,
  retryDelay: 5000,
  retryOn: [429, 502, 503, 504],
};

/**
 * Default health configuration.
 */
export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  enabled: true,
  port: 3001,
};

/**
 * Default heartbeat configuration.
 */
export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  enabled: true,
  interval: 5000,
  ttl: 15000,
};

/**
 * Default handlers configuration.
 */
export const DEFAULT_HANDLERS_CONFIG: HandlersConfig = {
  agent: {
    defaultTimeout: 300000, // 5 minutes
    retry: DEFAULT_AGENT_RETRY_CONFIG,
  },
  human: {
    defaultTimeout: 3600000, // 1 hour
    timeoutAction: 'escalate',
    escalationDelay: 300000, // 5 minutes
    defaultEscalationChannels: [],
  },
  integration: {
    defaultTimeout: 30000, // 30 seconds
    retry: DEFAULT_INTEGRATION_RETRY_CONFIG,
  },
};

/**
 * Default container configuration.
 */
export const DEFAULT_CONTAINER_CONFIG: ContainerConfig = {
  enabled: false,
  defaultImage: 'generacy-ai/dev-container:latest',
  cleanupOnFailure: true,
  cleanupOnSuccess: true,
  preserveForDebugging: false,
  cleanupTimeout: 30000,
  defaultVolumes: [],
  defaultEnvironment: {},
};

/**
 * Default worker configuration.
 */
export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  concurrency: 1,
  pollInterval: 1000,
  gracefulShutdownTimeout: 60000,
  forceShutdownOnTimeout: true,
  health: DEFAULT_HEALTH_CONFIG,
  heartbeat: DEFAULT_HEARTBEAT_CONFIG,
  handlers: DEFAULT_HANDLERS_CONFIG,
  containers: DEFAULT_CONTAINER_CONFIG,
};

/**
 * Configuration validation constraints.
 */
const CONFIG_VALIDATION = {
  concurrency: { min: 1, max: 10 },
  pollInterval: { min: 100, max: 60000 },
  gracefulShutdownTimeout: { min: 1000, max: 300000 },
  'health.port': { min: 1024, max: 65535 },
  'heartbeat.interval': { min: 1000, max: 60000 },
  'heartbeat.ttl': { min: 5000, max: 300000 },
} as const;

/**
 * Validation error details.
 */
export interface ValidationError {
  field: string;
  message: string;
  value?: unknown;
}

/**
 * Validate a numeric value is within range.
 */
function validateRange(
  value: number,
  field: string,
  min: number,
  max: number
): ValidationError | null {
  if (value < min || value > max) {
    return {
      field,
      message: `${field} must be between ${min} and ${max}`,
      value,
    };
  }
  return null;
}

/**
 * Validate worker configuration.
 *
 * @param config - Configuration to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateWorkerConfig(config: WorkerConfig): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate numeric ranges
  const rangeError1 = validateRange(
    config.concurrency,
    'concurrency',
    CONFIG_VALIDATION.concurrency.min,
    CONFIG_VALIDATION.concurrency.max
  );
  if (rangeError1) errors.push(rangeError1);

  const rangeError2 = validateRange(
    config.pollInterval,
    'pollInterval',
    CONFIG_VALIDATION.pollInterval.min,
    CONFIG_VALIDATION.pollInterval.max
  );
  if (rangeError2) errors.push(rangeError2);

  const rangeError3 = validateRange(
    config.gracefulShutdownTimeout,
    'gracefulShutdownTimeout',
    CONFIG_VALIDATION.gracefulShutdownTimeout.min,
    CONFIG_VALIDATION.gracefulShutdownTimeout.max
  );
  if (rangeError3) errors.push(rangeError3);

  if (config.health.enabled) {
    const rangeError4 = validateRange(
      config.health.port,
      'health.port',
      CONFIG_VALIDATION['health.port'].min,
      CONFIG_VALIDATION['health.port'].max
    );
    if (rangeError4) errors.push(rangeError4);
  }

  if (config.heartbeat.enabled) {
    const rangeError5 = validateRange(
      config.heartbeat.interval,
      'heartbeat.interval',
      CONFIG_VALIDATION['heartbeat.interval'].min,
      CONFIG_VALIDATION['heartbeat.interval'].max
    );
    if (rangeError5) errors.push(rangeError5);

    const rangeError6 = validateRange(
      config.heartbeat.ttl,
      'heartbeat.ttl',
      CONFIG_VALIDATION['heartbeat.ttl'].min,
      CONFIG_VALIDATION['heartbeat.ttl'].max
    );
    if (rangeError6) errors.push(rangeError6);

    // TTL should be at least 3x the interval for missed heartbeat detection
    if (config.heartbeat.ttl < config.heartbeat.interval * 3) {
      errors.push({
        field: 'heartbeat.ttl',
        message: 'heartbeat.ttl should be at least 3x heartbeat.interval for proper dead worker detection',
        value: config.heartbeat.ttl,
      });
    }
  }

  // Validate retry configs
  if (config.handlers.agent.retry.maxRetries < 0) {
    errors.push({
      field: 'handlers.agent.retry.maxRetries',
      message: 'maxRetries must be >= 0',
      value: config.handlers.agent.retry.maxRetries,
    });
  }

  if (config.handlers.integration.retry.maxRetries < 0) {
    errors.push({
      field: 'handlers.integration.retry.maxRetries',
      message: 'maxRetries must be >= 0',
      value: config.handlers.integration.retry.maxRetries,
    });
  }

  return errors;
}

/**
 * Create a worker configuration by merging with defaults.
 *
 * @param partial - Partial configuration to merge
 * @returns Complete worker configuration
 */
export function createWorkerConfig(partial: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...DEFAULT_WORKER_CONFIG,
    ...partial,
    health: {
      ...DEFAULT_HEALTH_CONFIG,
      ...partial.health,
    },
    heartbeat: {
      ...DEFAULT_HEARTBEAT_CONFIG,
      ...partial.heartbeat,
    },
    handlers: {
      agent: {
        ...DEFAULT_HANDLERS_CONFIG.agent,
        ...partial.handlers?.agent,
        retry: {
          ...DEFAULT_AGENT_RETRY_CONFIG,
          ...partial.handlers?.agent?.retry,
        },
      },
      human: {
        ...DEFAULT_HANDLERS_CONFIG.human,
        ...partial.handlers?.human,
      },
      integration: {
        ...DEFAULT_HANDLERS_CONFIG.integration,
        ...partial.handlers?.integration,
        retry: {
          ...DEFAULT_INTEGRATION_RETRY_CONFIG,
          ...partial.handlers?.integration?.retry,
        },
      },
    },
    containers: {
      ...DEFAULT_CONTAINER_CONFIG,
      ...partial.containers,
    },
  };
}
