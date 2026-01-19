/**
 * Type definitions for the job scheduler system.
 */

import type { RedisConfig, RetryConfig } from '../types/config.js';

/** Job priority levels for queue ordering */
export type JobPriority = 'high' | 'normal' | 'low';

/** Job status states */
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

/** Job type determines which handler processes it */
export type JobType = 'agent' | 'human' | 'integration';

/**
 * A unit of work in the queue.
 */
export interface Job {
  /** Unique job identifier (format: job_<uuid>) */
  id: string;

  /** Associated workflow ID */
  workflowId: string;

  /** Workflow step this job executes */
  stepId: string;

  /** Type of job - determines handler */
  type: JobType;

  /** Current job status */
  status: JobStatus;

  /** Priority level for queue ordering */
  priority: JobPriority;

  /** Number of execution attempts */
  attempts: number;

  /** Maximum attempts before dead letter */
  maxAttempts: number;

  /** Job-specific input data */
  payload: unknown;

  /** Result from successful execution */
  result?: unknown;

  /** Error message from failed execution */
  error?: string;

  /** Job creation timestamp (ISO 8601) */
  createdAt: string;

  /** Processing start timestamp */
  startedAt?: string;

  /** Completion timestamp (success or final failure) */
  completedAt?: string;

  /** Visibility timeout for processing (ms) */
  visibilityTimeout: number;

  /** Timestamp when visibility timeout expires (Unix ms) */
  visibleAt?: number;
}

/**
 * Input for creating a new job.
 */
export interface JobCreateInput {
  /** Associated workflow ID */
  workflowId: string;

  /** Workflow step this job executes */
  stepId: string;

  /** Type of job - determines handler */
  type: JobType;

  /** Priority level (default: 'normal') */
  priority?: JobPriority;

  /** Job-specific input data */
  payload: unknown;

  /** Maximum attempts before dead letter (default: 3) */
  maxAttempts?: number;

  /** Visibility timeout in ms (default: 30000) */
  visibilityTimeout?: number;
}

/** Default retry configuration for jobs */
export const DEFAULT_JOB_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
};

/** Default visibility timeout in milliseconds */
export const DEFAULT_VISIBILITY_TIMEOUT = 30000;

/** Default max attempts for jobs */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Concurrency control configuration.
 */
export interface ConcurrencyConfig {
  /** Maximum concurrent jobs globally */
  maxGlobalWorkers: number;

  /** Maximum concurrent jobs per workflow (optional) */
  maxPerWorkflow?: number;

  /** Maximum concurrent jobs per job type (optional) */
  maxPerJobType?: Partial<Record<JobType, number>>;
}

/**
 * Configuration for the job scheduler.
 */
export interface SchedulerConfig {
  /** Queue backend to use */
  backend: 'redis' | 'memory';

  /** Redis configuration (required for redis backend) */
  redis?: RedisConfig;

  /** Retry configuration */
  retry?: Partial<RetryConfig>;

  /** Concurrency settings */
  concurrency?: ConcurrencyConfig;

  /** Metrics emission interval (ms), 0 to disable */
  metricsIntervalMs?: number;

  /** Visibility timeout default (ms) */
  defaultVisibilityTimeout?: number;
}

/**
 * Creates a Job from JobCreateInput with defaults applied.
 */
export function createJob(input: JobCreateInput): Job {
  const now = new Date().toISOString();
  return {
    id: `job_${crypto.randomUUID()}`,
    workflowId: input.workflowId,
    stepId: input.stepId,
    type: input.type,
    status: 'pending',
    priority: input.priority ?? 'normal',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    payload: input.payload,
    createdAt: now,
    visibilityTimeout: input.visibilityTimeout ?? DEFAULT_VISIBILITY_TIMEOUT,
  };
}

/** Job processor function type */
export type JobProcessor = (job: Job) => Promise<unknown>;
