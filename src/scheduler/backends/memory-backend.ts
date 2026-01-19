/**
 * In-memory queue backend implementation.
 * Useful for testing and development without Redis.
 */

import type { QueueBackend, HealthCheckResult } from './backend.interface.js';
import type { Job, JobPriority } from '../types.js';

/**
 * In-memory implementation of the queue backend.
 * Uses separate arrays for each priority level with FIFO ordering.
 */
export class MemoryBackend implements QueueBackend {
  /** Job storage by ID */
  private jobs = new Map<string, Job>();

  /** Priority queues - arrays of job IDs */
  private queues: Record<JobPriority, string[]> = {
    high: [],
    normal: [],
    low: [],
  };

  /** Set of job IDs currently being processed */
  private processing = new Set<string>();

  /** Set of job IDs in dead letter queue */
  private deadLetter = new Set<string>();

  /** Connection state */
  private connected = false;

  // ============ Lifecycle ============

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.jobs.clear();
    this.queues = { high: [], normal: [], low: [] };
    this.processing.clear();
    this.deadLetter.clear();
  }

  // ============ Core Queue Operations ============

  async enqueue(job: Job): Promise<void> {
    this.jobs.set(job.id, { ...job });
    this.queues[job.priority].push(job.id);
  }

  async dequeue(priority?: JobPriority): Promise<Job | undefined> {
    // Priority order: high > normal > low
    const prioritiesToCheck: JobPriority[] = priority
      ? [priority]
      : ['high', 'normal', 'low'];

    for (const p of prioritiesToCheck) {
      const queue = this.queues[p];
      if (queue.length > 0) {
        const jobId = queue.shift()!;
        const job = this.jobs.get(jobId);

        if (job) {
          // Set visibility timeout
          const visibleAt = Date.now() + job.visibilityTimeout;
          const updatedJob: Job = {
            ...job,
            status: 'processing',
            startedAt: job.startedAt ?? new Date().toISOString(),
            visibleAt,
          };

          this.jobs.set(jobId, updatedJob);
          this.processing.add(jobId);
          return updatedJob;
        }
      }
    }

    return undefined;
  }

  async acknowledge(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.processing.delete(jobId);

    const updatedJob: Job = {
      ...job,
      status: 'completed',
      completedAt: new Date().toISOString(),
      visibleAt: undefined,
    };

    this.jobs.set(jobId, updatedJob);
  }

  async nack(jobId: string, error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    this.processing.delete(jobId);

    const newAttempts = job.attempts + 1;
    const shouldDie = newAttempts >= job.maxAttempts;

    const updatedJob: Job = {
      ...job,
      attempts: newAttempts,
      error,
      status: shouldDie ? 'dead' : 'pending',
      completedAt: shouldDie ? new Date().toISOString() : undefined,
      visibleAt: undefined,
    };

    this.jobs.set(jobId, updatedJob);

    if (shouldDie) {
      this.deadLetter.add(jobId);
    } else {
      // Re-queue at the back of the priority queue
      this.queues[job.priority].push(jobId);
    }
  }

  // ============ Job Management ============

  async getJob(id: string): Promise<Job | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async updateJob(id: string, update: Partial<Job>): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    this.jobs.set(id, { ...job, ...update });
  }

  // ============ Queue Info ============

  async getQueueDepth(priority?: JobPriority): Promise<number> {
    if (priority) {
      return this.queues[priority].length;
    }

    return (
      this.queues.high.length +
      this.queues.normal.length +
      this.queues.low.length
    );
  }

  async getProcessingCount(): Promise<number> {
    return this.processing.size;
  }

  // ============ Dead Letter Operations ============

  async getDeadLetterJobs(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const jobId of this.deadLetter) {
      const job = this.jobs.get(jobId);
      if (job) {
        jobs.push({ ...job });
      }
    }
    return jobs;
  }

  async retryDeadLetter(jobId: string): Promise<void> {
    if (!this.deadLetter.has(jobId)) {
      throw new Error(`Job ${jobId} is not in dead letter queue`);
    }

    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    this.deadLetter.delete(jobId);

    const updatedJob: Job = {
      ...job,
      status: 'pending',
      attempts: 0,
      error: undefined,
      completedAt: undefined,
      visibleAt: undefined,
    };

    this.jobs.set(jobId, updatedJob);
    this.queues[job.priority].push(jobId);
  }

  // ============ Visibility Timeout ============

  async refreshVisibility(jobId: string, timeoutMs: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const updatedJob: Job = {
      ...job,
      visibleAt: Date.now() + timeoutMs,
    };

    this.jobs.set(jobId, updatedJob);
  }

  async releaseTimedOutJobs(): Promise<number> {
    const now = Date.now();
    let released = 0;

    for (const jobId of this.processing) {
      const job = this.jobs.get(jobId);
      if (job && job.visibleAt && job.visibleAt <= now) {
        this.processing.delete(jobId);

        const updatedJob: Job = {
          ...job,
          status: 'pending',
          visibleAt: undefined,
        };

        this.jobs.set(jobId, updatedJob);
        this.queues[job.priority].push(jobId);
        released++;
      }
    }

    return released;
  }

  // ============ Health Check ============

  async healthCheck(): Promise<HealthCheckResult> {
    const queueDepth = await this.getQueueDepth();

    return {
      healthy: this.connected,
      details: {
        connected: this.connected,
        queueDepth,
      },
    };
  }
}
