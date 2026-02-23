/**
 * Job queue module for the orchestrator server.
 * Provides an in-memory job queue implementation with priority-based ordering.
 */

import type { Job, JobStatus, JobResult, JobPriority } from './types.js';

/**
 * Job queue interface for managing workflow jobs.
 */
export interface JobQueue {
  /**
   * Add a job to the queue.
   * @param job - The job to enqueue
   */
  enqueue(job: Job): Promise<void>;

  /**
   * Poll for the next available job matching worker capabilities.
   * @param workerId - The worker ID requesting a job
   * @param capabilities - Array of capability tags the worker supports
   * @returns The next job or null if none available
   */
  poll(workerId: string, capabilities: string[]): Promise<Job | null>;

  /**
   * Update the status of a job.
   * @param jobId - The job ID to update
   * @param status - The new status
   * @param metadata - Optional metadata to merge with job metadata
   */
  updateStatus(jobId: string, status: JobStatus, metadata?: Record<string, unknown>): Promise<void>;

  /**
   * Report the result of a completed job.
   * @param jobId - The job ID
   * @param result - The job result
   */
  reportResult(jobId: string, result: JobResult): Promise<void>;

  /**
   * Get a job by ID.
   * @param jobId - The job ID to retrieve
   * @returns The job or null if not found
   */
  getJob(jobId: string): Promise<Job | null>;

  /**
   * Cancel a job.
   * @param jobId - The job ID to cancel
   * @param reason - Optional cancellation reason
   */
  cancelJob(jobId: string, reason?: string): Promise<void>;

  /**
   * Requeue a job that was dequeued but could not be assigned.
   * Returns the job to the pending queue at its correct priority position.
   * @param jobId - The job ID to requeue
   * @throws Error if job not found or not in 'assigned' status
   */
  requeue(jobId: string): Promise<void>;
}

/**
 * Priority ordering: urgent > high > normal > low
 */
const PRIORITY_ORDER: Record<JobPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * In-memory job queue implementation.
 * WARNING: This queue stores all data in memory and will lose all jobs on restart.
 */
export class InMemoryJobQueue implements JobQueue {
  /** Map of job ID to job data */
  private jobs: Map<string, Job> = new Map();

  /** Array of pending job IDs sorted by priority (highest first) */
  private pendingQueue: string[] = [];

  constructor() {
    console.warn(
      '[JobQueue] Using in-memory job queue. All queued jobs will be lost on server restart. ' +
        'Consider using a persistent backend (e.g., Redis) for production deployments.'
    );
  }

  /**
   * Insert a job ID into the pending queue maintaining priority order.
   */
  private insertIntoQueue(jobId: string, priority: JobPriority): void {
    const priorityValue = PRIORITY_ORDER[priority];

    // Find the insertion index to maintain descending priority order
    let insertIndex = this.pendingQueue.length;
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const existingJobId = this.pendingQueue[i];
      if (existingJobId === undefined) continue;
      const existingJob = this.jobs.get(existingJobId);
      if (existingJob) {
        const existingPriority = PRIORITY_ORDER[existingJob.priority];
        if (priorityValue > existingPriority) {
          insertIndex = i;
          break;
        }
      }
    }

    this.pendingQueue.splice(insertIndex, 0, jobId);
  }

  /**
   * Check if a job matches the given worker capabilities.
   */
  private matchesCapabilities(job: Job, capabilities: string[]): boolean {
    // Empty capabilities or wildcard matches all jobs
    if (capabilities.length === 0 || capabilities.includes('*')) {
      return true;
    }

    // If job has no tags, only wildcard workers can match
    if (!job.tags || job.tags.length === 0) {
      return true; // Jobs without tags can be picked up by any worker
    }

    // Check if any of the job's tags match worker capabilities
    return job.tags.some((tag) => capabilities.includes(tag));
  }

  async enqueue(job: Job): Promise<void> {
    // Store the job
    this.jobs.set(job.id, { ...job });

    // Only add to pending queue if status is 'pending'
    if (job.status === 'pending') {
      this.insertIntoQueue(job.id, job.priority);
    }
  }

  async poll(workerId: string, capabilities: string[]): Promise<Job | null> {
    // Find the highest priority pending job that matches capabilities
    for (let i = 0; i < this.pendingQueue.length; i++) {
      const jobId = this.pendingQueue[i];
      if (jobId === undefined) continue;
      const job = this.jobs.get(jobId);

      if (!job) {
        // Clean up stale queue entry
        this.pendingQueue.splice(i, 1);
        i--;
        continue;
      }

      if (job.status !== 'pending') {
        // Job is no longer pending, remove from queue
        this.pendingQueue.splice(i, 1);
        i--;
        continue;
      }

      if (this.matchesCapabilities(job, capabilities)) {
        // Remove from pending queue
        this.pendingQueue.splice(i, 1);

        // Update job to assigned status
        const now = new Date().toISOString();
        job.status = 'assigned';
        job.assignedAt = now;
        job.workerId = workerId;

        return { ...job };
      }
    }

    return null;
  }

  async updateStatus(
    jobId: string,
    status: JobStatus,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const now = new Date().toISOString();

    // Update status
    job.status = status;

    // Update relevant timestamps based on status
    switch (status) {
      case 'running':
        job.startedAt = now;
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        job.completedAt = now;
        break;
      case 'assigned':
        job.assignedAt = now;
        break;
    }

    // Merge metadata if provided
    if (metadata) {
      job.metadata = {
        ...job.metadata,
        ...metadata,
      };
    }

    // If job goes back to pending, re-add to queue
    if (status === 'pending') {
      this.insertIntoQueue(jobId, job.priority);
    }
  }

  async reportResult(jobId: string, result: JobResult): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const now = new Date().toISOString();

    // Update job status from result
    job.status = result.status;
    job.completedAt = now;

    // Store result data in metadata
    job.metadata = {
      ...job.metadata,
      result: {
        outputs: result.outputs,
        error: result.error,
        errorStack: result.errorStack,
        duration: result.duration,
        phases: result.phases,
        steps: result.steps,
      },
    };
  }

  async getJob(jobId: string): Promise<Job | null> {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  async cancelJob(jobId: string, reason?: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Only cancel if not already in a terminal state
    const terminalStates: JobStatus[] = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(job.status)) {
      return; // Already in terminal state, no-op
    }

    const now = new Date().toISOString();
    job.status = 'cancelled';
    job.completedAt = now;

    // Store cancellation reason in metadata
    if (reason) {
      job.metadata = {
        ...job.metadata,
        cancellationReason: reason,
      };
    }

    // Remove from pending queue if present
    const queueIndex = this.pendingQueue.indexOf(jobId);
    if (queueIndex !== -1) {
      this.pendingQueue.splice(queueIndex, 1);
    }
  }

  async requeue(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status !== 'assigned') {
      throw new Error(`Cannot requeue job ${jobId}: expected status 'assigned', got '${job.status}'`);
    }

    // Reset to clean pending state
    job.status = 'pending';
    job.workerId = undefined;
    job.assignedAt = undefined;

    // Re-insert at correct priority position
    this.insertIntoQueue(jobId, job.priority);
  }
}
