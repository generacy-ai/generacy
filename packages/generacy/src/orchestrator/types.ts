/**
 * Orchestrator types.
 * Defines job, worker, and communication types matching the orchestrator API.
 */

/**
 * Job status values
 */
export type JobStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Job priority levels
 */
export type JobPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Job definition from orchestrator
 */
export interface Job {
  /** Unique job identifier */
  id: string;

  /** Job name or title */
  name: string;

  /** Current status */
  status: JobStatus;

  /** Job priority */
  priority: JobPriority;

  /** Workflow definition or path */
  workflow: string | Record<string, unknown>;

  /** Input values for the workflow */
  inputs: Record<string, unknown>;

  /** Working directory override */
  workdir?: string;

  /** Maximum execution time in seconds */
  timeout?: number;

  /** Number of retry attempts */
  retries?: number;

  /** Assigned worker ID */
  workerId?: string;

  /** Job creation timestamp */
  createdAt: string;

  /** Job assignment timestamp */
  assignedAt?: string;

  /** Job start timestamp */
  startedAt?: string;

  /** Job completion timestamp */
  completedAt?: string;

  /** Metadata tags */
  tags?: string[];

  /** Additional job metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Job result reported back to orchestrator
 */
export interface JobResult {
  /** Job ID */
  jobId: string;

  /** Final status */
  status: 'completed' | 'failed' | 'cancelled';

  /** Execution outputs */
  outputs?: Record<string, unknown>;

  /** Error message if failed */
  error?: string;

  /** Error stack trace */
  errorStack?: string;

  /** Execution duration in milliseconds */
  duration: number;

  /** Phases executed */
  phases?: Array<{
    name: string;
    status: string;
    duration: number;
  }>;

  /** Step-level results */
  steps?: Array<{
    name: string;
    status: string;
    duration: number;
    error?: string;
  }>;
}

/**
 * Worker registration request
 */
export interface WorkerRegistration {
  /** Worker unique identifier */
  id: string;

  /** Worker name */
  name: string;

  /** Worker capabilities/tags */
  capabilities: string[];

  /** Maximum concurrent jobs */
  maxConcurrent: number;

  /** Health check endpoint URL */
  healthEndpoint?: string;

  /** Worker metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Worker heartbeat data
 */
export interface Heartbeat {
  /** Worker ID */
  workerId: string;

  /** Worker status */
  status: 'idle' | 'busy' | 'stopping';

  /** Currently executing job ID */
  currentJob?: string;

  /** Current job progress (0-100) */
  progress?: number;

  /** System metrics */
  metrics?: {
    cpuUsage?: number;
    memoryUsage?: number;
    uptime?: number;
  };

  /** Timestamp */
  timestamp: string;
}

/**
 * Command from orchestrator to worker
 */
export interface HeartbeatCommand {
  type: 'cancel' | 'shutdown' | 'config-update';
  payload?: Record<string, unknown>;
}

/**
 * Heartbeat response from orchestrator
 */
export interface HeartbeatResponse {
  /** Whether heartbeat was accepted */
  acknowledged: boolean;

  /** Commands from orchestrator */
  commands?: HeartbeatCommand[];
}

/**
 * Job poll response
 */
export interface PollResponse {
  /** Job to execute, if any */
  job?: Job;

  /** Poll again after this many milliseconds */
  retryAfter?: number;
}

/**
 * Orchestrator API error
 */
export interface OrchestratorError {
  /** Error code */
  code: string;

  /** Error message */
  message: string;

  /** Additional details */
  details?: Record<string, unknown>;
}
