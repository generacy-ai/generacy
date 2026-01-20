/**
 * Type definitions for the Worker Service.
 */

import type { Job, JobType } from '../scheduler/types.js';

// ============ Worker Status & Metrics ============

/** Worker operational status */
export type WorkerStatus = 'idle' | 'processing' | 'draining' | 'stopped';

/** Metrics tracked by the worker */
export interface WorkerMetrics {
  /** Total jobs processed since start */
  jobsProcessed: number;
  /** Jobs that completed successfully */
  jobsSucceeded: number;
  /** Jobs that failed after all retries */
  jobsFailed: number;
  /** Current error rate (failed/processed) */
  errorRate: number;
  /** Average processing time in ms */
  avgProcessingTime: number;
  /** Last job processing time in ms */
  lastProcessingTime?: number;
}

/** Heartbeat data published to Redis */
export interface WorkerHeartbeat {
  /** Unique worker identifier */
  workerId: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Current worker status */
  status: WorkerStatus;
  /** Current job ID if processing */
  currentJob?: string;
  /** Worker metrics */
  metrics: WorkerMetrics;
}

// ============ Job Handler Interface ============

/** Result from a job handler */
export interface JobResult {
  /** Whether the job succeeded */
  success: boolean;
  /** Output data from the job */
  output: unknown;
  /** Processing duration in ms */
  duration?: number;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/** Handler interface for processing jobs */
export interface JobHandler {
  /** Handle a job and return the result */
  handle(job: Job): Promise<JobResult>;
}

// ============ Job Payloads ============

/** Payload for agent jobs */
export interface AgentJobPayload {
  /** Agent name (default: 'claude-code') */
  agent?: string;
  /** Command to execute */
  command: string;
  /** Execution context */
  context: {
    workingDirectory: string;
    environment?: Record<string, string>;
    mode?: string;
    issueNumber?: number;
    branch?: string;
  };
  /** Job-specific timeout in ms */
  timeout?: number;
  /** Optional container overrides */
  container?: ContainerOverrides;
}

/** Option for human decision jobs */
export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

/** Escalation configuration for human jobs */
export interface EscalationConfig {
  /** Action on timeout */
  timeoutAction: 'escalate' | 'fail';
  /** Channels to escalate through */
  escalationChannels: string[];
  /** Delay between escalations in ms */
  escalationDelay: number;
}

/** Payload for human jobs */
export interface HumanJobPayload {
  /** Type of human interaction */
  type: 'approval' | 'decision' | 'input';
  /** Title for the request */
  title: string;
  /** Description of what's needed */
  description: string;
  /** Options for decision type */
  options?: DecisionOption[];
  /** Assigned user */
  assignee?: string;
  /** Urgency level */
  urgency: 'low' | 'normal' | 'high' | 'critical';
  /** Timeout in ms */
  timeout: number;
  /** Escalation configuration */
  escalation?: EscalationConfig;
}

/** Payload for integration jobs */
export interface IntegrationJobPayload {
  /** Integration name */
  integration: string;
  /** Action to perform */
  action: string;
  /** Action parameters */
  params: Record<string, unknown>;
  /** Job-specific timeout in ms */
  timeout?: number;
}

// ============ Job Results ============

/** Result from agent job execution */
export interface AgentJobResult extends JobResult {
  output: string;
  exitCode?: number;
  toolCalls?: Array<{
    toolName: string;
    success: boolean;
    duration: number;
    timestamp: Date;
    inputSummary?: string;
    outputSummary?: string;
    errorMessage?: string;
  }>;
  error?: {
    code: string;
    message: string;
  };
}

/** Result from human job execution */
export interface HumanJobResult extends JobResult {
  output: {
    decision?: string;
    input?: string;
    approved?: boolean;
    respondedBy: string;
    respondedAt: string;
  };
}

/** Result from integration job execution */
export interface IntegrationJobResult extends JobResult {
  output: unknown;
  statusCode?: number;
}

// ============ Configuration Types ============

/** Health check endpoint configuration */
export interface HealthConfig {
  /** Enable health endpoints */
  enabled: boolean;
  /** Port for health server */
  port: number;
}

/** Heartbeat configuration */
export interface HeartbeatConfig {
  /** Enable heartbeat publishing */
  enabled: boolean;
  /** Heartbeat interval in ms */
  interval: number;
  /** Heartbeat TTL in Redis (ms) */
  ttl: number;
}

/** Retry configuration for agent jobs */
export interface AgentRetryConfig {
  /** Maximum retry attempts */
  maxRetries: number;
  /** Initial delay between retries in ms */
  initialDelay: number;
  /** Maximum delay between retries in ms */
  maxDelay: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Error codes that are retryable */
  retryableErrors: string[];
}

/** Configuration for agent handler */
export interface AgentHandlerConfig {
  /** Default timeout in ms */
  defaultTimeout: number;
  /** Retry configuration */
  retry: AgentRetryConfig;
}

/** Configuration for human handler */
export interface HumanHandlerConfig {
  /** Default timeout in ms */
  defaultTimeout: number;
  /** Action on timeout */
  timeoutAction: 'escalate' | 'fail';
  /** Delay between escalations in ms */
  escalationDelay: number;
  /** Default escalation channels */
  defaultEscalationChannels: string[];
}

/** Retry configuration for integration jobs */
export interface IntegrationRetryConfig {
  /** Maximum retry attempts */
  maxRetries: number;
  /** Delay between retries in ms */
  retryDelay: number;
  /** HTTP status codes to retry on */
  retryOn: number[];
}

/** Configuration for integration handler */
export interface IntegrationHandlerConfig {
  /** Default timeout in ms */
  defaultTimeout: number;
  /** Retry configuration */
  retry: IntegrationRetryConfig;
}

/** Volume mount configuration */
export interface VolumeMount {
  source: string;
  target: string;
  readonly?: boolean;
}

/** Container configuration */
export interface ContainerConfig {
  /** Enable container isolation */
  enabled: boolean;
  /** Default container image */
  defaultImage: string;
  /** Cleanup container on failure */
  cleanupOnFailure: boolean;
  /** Cleanup container on success */
  cleanupOnSuccess: boolean;
  /** Keep container for debugging */
  preserveForDebugging: boolean;
  /** Cleanup timeout in ms */
  cleanupTimeout: number;
  /** Default volume mounts */
  defaultVolumes: VolumeMount[];
  /** Default environment variables */
  defaultEnvironment: Record<string, string>;
  /** Network mode */
  networkMode?: string;
}

/** Container configuration overrides for specific jobs */
export interface ContainerOverrides {
  image?: string;
  volumes?: VolumeMount[];
  environment?: Record<string, string>;
  cleanupOnFailure?: boolean;
}

/** Health endpoint response */
export interface HealthResponse {
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Uptime in seconds */
  uptime: number;
  /** Number of jobs currently processing */
  currentJobs: number;
  /** Timestamp of last completed job */
  lastJobCompleted: string | null;
  /** Worker version */
  version: string;
  /** Additional health details */
  details?: {
    redis: 'connected' | 'disconnected';
    queueDepth?: number;
  };
}

/** Handler configuration grouping */
export interface HandlersConfig {
  agent: AgentHandlerConfig;
  human: HumanHandlerConfig;
  integration: IntegrationHandlerConfig;
}

/** Redis configuration */
export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
}

/** Complete worker configuration */
export interface WorkerConfig {
  /** Unique worker identifier (auto-generated if not provided) */
  workerId?: string;

  /** Maximum concurrent jobs */
  concurrency: number;

  /** Queue polling interval in ms */
  pollInterval: number;

  /** Graceful shutdown timeout in ms */
  gracefulShutdownTimeout: number;

  /** Force shutdown after timeout */
  forceShutdownOnTimeout: boolean;

  /** Health endpoint configuration */
  health: HealthConfig;

  /** Heartbeat configuration */
  heartbeat: HeartbeatConfig;

  /** Redis connection configuration */
  redis?: RedisConnectionConfig;

  /** Handler configurations */
  handlers: HandlersConfig;

  /** Container configuration */
  containers: ContainerConfig;
}

// ============ Worker Events ============

/** Events emitted by the worker processor */
export type WorkerEvent =
  | { type: 'started'; workerId: string }
  | { type: 'stopped'; workerId: string }
  | { type: 'job:started'; job: Job }
  | { type: 'job:completed'; job: Job; result: JobResult }
  | { type: 'job:failed'; job: Job; error: Error }
  | { type: 'job:retrying'; job: Job; attempt: number; delay: number }
  | { type: 'metrics:snapshot'; metrics: WorkerMetrics }
  | { type: 'shutdown:initiated' }
  | { type: 'shutdown:timeout'; job?: Job };

/** Worker event handler types */
export interface WorkerEventHandlers {
  started: (workerId: string) => void;
  stopped: (workerId: string) => void;
  'job:started': (job: Job) => void;
  'job:completed': (job: Job, result: JobResult) => void;
  'job:failed': (job: Job, error: Error) => void;
  'job:retrying': (job: Job, attempt: number, delay: number) => void;
  'metrics:snapshot': (metrics: WorkerMetrics) => void;
  'shutdown:initiated': () => void;
  'shutdown:timeout': (job?: Job) => void;
}
