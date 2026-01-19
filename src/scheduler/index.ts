/**
 * Job Scheduler Module
 *
 * Provides priority-based job queuing, retry with exponential backoff,
 * dead letter handling, and pluggable backends (Redis and in-memory).
 *
 * @packageDocumentation
 */

// Core types
export type {
  Job,
  JobCreateInput,
  JobPriority,
  JobStatus,
  JobType,
  JobProcessor as JobProcessorFn,
  SchedulerConfig,
  ConcurrencyConfig,
} from './types.js';

export {
  createJob,
  DEFAULT_JOB_RETRY_CONFIG,
  DEFAULT_VISIBILITY_TIMEOUT,
  DEFAULT_MAX_ATTEMPTS,
} from './types.js';

// Event types
export type {
  SchedulerEvents,
  SchedulerMetrics,
} from './events.js';

export {
  SchedulerEventEmitter,
  SCHEDULER_EVENT_NAMES,
  type SchedulerEventName,
} from './events.js';

// Backend types and implementations
export type {
  QueueBackend,
  HealthCheckResult,
} from './backends/index.js';

export {
  MemoryBackend,
  RedisBackend,
  SCHEDULER_KEYS,
} from './backends/index.js';

// Core classes
export {
  JobScheduler,
  type JobSchedulerOptions,
  type QueueStats,
} from './job-scheduler.js';

export {
  JobProcessor,
  type JobProcessorOptions,
} from './job-processor.js';
