/**
 * JobProcessor - Worker that processes jobs from the scheduler.
 */

import type { JobScheduler } from './job-scheduler.js';
import type { Job, JobProcessor as JobProcessorFn } from './types.js';
import { DEFAULT_JOB_RETRY_CONFIG } from './types.js';
import { calculateRetryDelay } from '../utils/retry.js';

/**
 * Options for the JobProcessor.
 */
export interface JobProcessorOptions {
  /** Poll interval in milliseconds (default: 100) */
  pollIntervalMs?: number;

  /** Maximum concurrent jobs to process (default: 1) */
  maxConcurrent?: number;

  /** Interval to check for visibility timeouts (default: 30000) */
  visibilityCheckIntervalMs?: number;
}

/**
 * Job processor that polls the scheduler and executes jobs.
 */
export class JobProcessor {
  private scheduler: JobScheduler;
  private handler: JobProcessorFn;
  private options: Required<JobProcessorOptions>;

  private running = false;
  private pollTimeout?: ReturnType<typeof setTimeout>;
  private visibilityTimeout?: ReturnType<typeof setInterval>;
  private activeJobs = new Map<string, Promise<void>>();

  constructor(
    scheduler: JobScheduler,
    handler: JobProcessorFn,
    options: JobProcessorOptions = {}
  ) {
    this.scheduler = scheduler;
    this.handler = handler;
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? 100,
      maxConcurrent: options.maxConcurrent ?? 1,
      visibilityCheckIntervalMs: options.visibilityCheckIntervalMs ?? 30000,
    };
  }

  /**
   * Start processing jobs.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll();
    this.startVisibilityCheck();
  }

  /**
   * Stop processing jobs.
   * Note: Does not wait for active jobs to complete.
   */
  stop(): void {
    this.running = false;

    if (this.pollTimeout) {
      clearTimeout(this.pollTimeout);
      this.pollTimeout = undefined;
    }

    if (this.visibilityTimeout) {
      clearInterval(this.visibilityTimeout);
      this.visibilityTimeout = undefined;
    }
  }

  /**
   * Check if the processor is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of currently active jobs.
   */
  getActiveCount(): number {
    return this.activeJobs.size;
  }

  /**
   * Wait for all active jobs to complete.
   */
  async drain(): Promise<void> {
    await Promise.all(this.activeJobs.values());
  }

  // ============ Internal Processing ============

  private scheduleNextPoll(): void {
    if (!this.running) return;

    this.pollTimeout = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll();
    }, this.options.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;
    if (this.scheduler.isPaused()) return;
    if (this.activeJobs.size >= this.options.maxConcurrent) return;

    try {
      const job = await this.scheduler.dequeue();
      if (job) {
        this.processJob(job);
      }
    } catch {
      // Ignore poll errors
    }
  }

  private processJob(job: Job): void {
    const processing = this.executeJob(job);
    this.activeJobs.set(job.id, processing);

    processing.finally(() => {
      this.activeJobs.delete(job.id);
    });
  }

  private async executeJob(job: Job): Promise<void> {
    try {
      const result = await this.handler(job);
      await this.scheduler.acknowledge(job.id, result);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.handleJobError(job, err);
    }
  }

  private async handleJobError(job: Job, error: Error): Promise<void> {
    // Update the job with the error
    await this.scheduler.nack(job.id, error);

    // Check if we should schedule a retry
    const updatedJob = await this.scheduler.getJob(job.id);
    if (updatedJob && updatedJob.status === 'pending') {
      // Calculate delay for retry
      const delay = calculateRetryDelay(updatedJob.attempts - 1, DEFAULT_JOB_RETRY_CONFIG);

      // Schedule retry after delay
      // Note: In a real system, this would be handled by the queue backend
      // For simplicity, we just let the next poll pick it up
      // The job is already back in the queue from nack()
    }
  }

  // ============ Visibility Timeout ============

  private startVisibilityCheck(): void {
    if (this.visibilityTimeout) return;

    this.visibilityTimeout = setInterval(async () => {
      try {
        await this.scheduler.releaseTimedOutJobs();
      } catch {
        // Ignore visibility check errors
      }
    }, this.options.visibilityCheckIntervalMs);
  }
}
