/**
 * Queue backend interface that all implementations must follow.
 */

import type { Job, JobPriority } from '../types.js';

/**
 * Health check result from a backend.
 */
export interface HealthCheckResult {
  /** Whether the backend is healthy */
  healthy: boolean;

  /** Additional health details */
  details?: {
    /** Whether connected to backing store */
    connected: boolean;

    /** Current queue depth */
    queueDepth: number;

    /** Last error message if any */
    lastError?: string;
  };
}

/**
 * Interface that all queue backends must implement.
 */
export interface QueueBackend {
  // ============ Core Queue Operations ============

  /**
   * Add a job to the queue.
   */
  enqueue(job: Job): Promise<void>;

  /**
   * Fetch the highest priority job from the queue.
   * Sets visibility timeout on the job.
   *
   * @param priority - Optional priority filter
   * @returns The job or undefined if queue is empty
   */
  dequeue(priority?: JobPriority): Promise<Job | undefined>;

  /**
   * Acknowledge successful job completion.
   * Removes the job from the processing set.
   */
  acknowledge(jobId: string): Promise<void>;

  /**
   * Negative acknowledge - job processing failed.
   * Increments attempts and either re-queues or moves to dead letter.
   */
  nack(jobId: string, error: string): Promise<void>;

  // ============ Job Management ============

  /**
   * Get a job by ID.
   */
  getJob(id: string): Promise<Job | undefined>;

  /**
   * Update a job's properties.
   */
  updateJob(id: string, update: Partial<Job>): Promise<void>;

  // ============ Queue Info ============

  /**
   * Get the number of jobs in the queue.
   *
   * @param priority - Optional priority filter
   */
  getQueueDepth(priority?: JobPriority): Promise<number>;

  /**
   * Get the number of jobs currently being processed.
   */
  getProcessingCount(): Promise<number>;

  // ============ Dead Letter Operations ============

  /**
   * Get all jobs in the dead letter queue.
   */
  getDeadLetterJobs(): Promise<Job[]>;

  /**
   * Retry a job from the dead letter queue.
   * Resets attempts and moves back to main queue.
   */
  retryDeadLetter(jobId: string): Promise<void>;

  // ============ Visibility Timeout ============

  /**
   * Extend the visibility timeout for a job.
   */
  refreshVisibility(jobId: string, timeoutMs: number): Promise<void>;

  /**
   * Release jobs whose visibility timeout has expired.
   *
   * @returns Number of jobs released
   */
  releaseTimedOutJobs(): Promise<number>;

  // ============ Lifecycle ============

  /**
   * Connect to the backing store.
   */
  connect(): Promise<void>;

  /**
   * Disconnect from the backing store.
   */
  disconnect(): Promise<void>;

  /**
   * Check the health of the backend.
   */
  healthCheck(): Promise<HealthCheckResult>;
}
