/**
 * Worker configuration exports.
 */

export {
  DEFAULT_WORKER_CONFIG,
  DEFAULT_AGENT_RETRY_CONFIG,
  DEFAULT_INTEGRATION_RETRY_CONFIG,
  DEFAULT_HEALTH_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  createWorkerConfig,
  validateWorkerConfig,
  type ValidationError,
} from './worker-config.js';
