/**
 * JobScheduler - Main scheduler class coordinating queue operations.
 */

import type { QueueBackend, HealthCheckResult } from './backends/backend.interface.js';
import { MemoryBackend } from './backends/memory-backend.js';
import type {
  Job,
  JobCreateInput,
  JobPriority,
  SchedulerConfig,
} from './types.js';
import { createJob } from './types.js';
import {
  SchedulerEventEmitter,
  type SchedulerEvents,
  type SchedulerMetrics,
} from './events.js';

/**
 * Queue statistics for monitoring.
 */
export interface QueueStats {
  /** Queue depth by priority */
  queueDepth: {
    high: number;
    normal: number;
    low: number;
    total: number;
  };
  /** Currently processing jobs */
  processing: number;
  /** Jobs in dead letter queue */
  deadLetter: number;
}

/**
 * Options for creating a JobScheduler.
 */
export interface JobSchedulerOptions {
  /** Queue backend instance (defaults to MemoryBackend) */
  backend?: QueueBackend;
  /** Scheduler configuration */
  config?: Partial<SchedulerConfig>;
}

/**
 * Job scheduler that coordinates queue operations and emits events.
 */
export class JobScheduler extends SchedulerEventEmitter {
  private backend: QueueBackend;
  private config: SchedulerConfig;
  private paused = false;
  private started = false;
  private metricsInterval?: ReturnType<typeof setInterval>;

  constructor(options: JobSchedulerOptions = {}) {
    super();

    this.backend = options.backend ?? new MemoryBackend();
    this.config = {
      backend: 'memory',
      metricsIntervalMs: 60000,
      defaultVisibilityTimeout: 30000,
      ...options.config,
    };
  }

  /**
   * Start the scheduler and connect to the backend.
   */
  async start(): Promise<void> {
    if (this.started) return;

    await this.backend.connect();
    this.started = true;

    // Start metrics emission if configured
    if (this.config.metricsIntervalMs && this.config.metricsIntervalMs > 0) {
      this.startMetricsEmission();
    }
  }

  /**
   * Stop the scheduler and disconnect from the backend.
   */
  async stop(): Promise<void> {
    if (!this.started) return;

    this.stopMetricsEmission();
    await this.backend.disconnect();
    this.started = false;
  }

  /**
   * Enqueue a new job.
   *
   * @param input - Job creation input
   * @returns The created job ID
   */
  async enqueue(input: JobCreateInput): Promise<string> {
    const job = createJob(input);
    await this.backend.enqueue(job);
    this.emit('job:enqueued', job);
    return job.id;
  }

  /**
   * Dequeue the highest priority job.
   *
   * @param priority - Optional priority filter
   * @returns The dequeued job or undefined
   */
  async dequeue(priority?: JobPriority): Promise<Job | undefined> {
    const job = await this.backend.dequeue(priority);

    if (job) {
      this.emit('job:started', job);
    }

    return job;
  }

  /**
   * Get a job by ID.
   */
  async getJob(id: string): Promise<Job | undefined> {
    return this.backend.getJob(id);
  }

  /**
   * Update a job's properties.
   */
  async updateJob(id: string, update: Partial<Job>): Promise<void> {
    return this.backend.updateJob(id, update);
  }

  /**
   * Pause job processing.
   * Note: This does not prevent dequeue calls, but signals to processors to stop.
   */
  pause(): void {
    this.paused = true;
  }

  /**
   * Resume job processing.
   */
  resume(): void {
    this.paused = false;
  }

  /**
   * Check if scheduler is paused.
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Get all jobs in the dead letter queue.
   */
  async getDeadLetterQueue(): Promise<Job[]> {
    return this.backend.getDeadLetterJobs();
  }

  /**
   * Retry a job from the dead letter queue.
   */
  async retryDeadLetter(jobId: string): Promise<void> {
    return this.backend.retryDeadLetter(jobId);
  }

  /**
   * Get current queue statistics.
   */
  async getQueueStats(): Promise<QueueStats> {
    const [high, normal, low, processing, deadLetterJobs] = await Promise.all([
      this.backend.getQueueDepth('high'),
      this.backend.getQueueDepth('normal'),
      this.backend.getQueueDepth('low'),
      this.backend.getProcessingCount(),
      this.backend.getDeadLetterJobs(),
    ]);

    return {
      queueDepth: {
        high,
        normal,
        low,
        total: high + normal + low,
      },
      processing,
      deadLetter: deadLetterJobs.length,
    };
  }

  /**
   * Check the health of the scheduler and backend.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    return this.backend.healthCheck();
  }

  /**
   * Acknowledge successful job completion.
   */
  async acknowledge(jobId: string, result?: unknown): Promise<void> {
    const job = await this.backend.getJob(jobId);
    if (job) {
      await this.backend.acknowledge(jobId);
      if (result !== undefined) {
        await this.backend.updateJob(jobId, { result });
      }
      const updatedJob = await this.backend.getJob(jobId);
      if (updatedJob) {
        this.emit('job:completed', updatedJob, result);
      }
    }
  }

  /**
   * Report job processing failure.
   */
  async nack(jobId: string, error: Error): Promise<void> {
    const job = await this.backend.getJob(jobId);
    if (!job) return;

    await this.backend.nack(jobId, error.message);

    const updatedJob = await this.backend.getJob(jobId);
    if (updatedJob) {
      if (updatedJob.status === 'dead') {
        this.emit('job:dead', updatedJob);
      } else {
        this.emit('job:failed', updatedJob, error);
      }
    }
  }

  /**
   * Release jobs whose visibility timeout has expired.
   */
  async releaseTimedOutJobs(): Promise<number> {
    return this.backend.releaseTimedOutJobs();
  }

  /**
   * Refresh visibility timeout for a job.
   */
  async refreshVisibility(jobId: string, timeoutMs?: number): Promise<void> {
    const timeout = timeoutMs ?? this.config.defaultVisibilityTimeout ?? 30000;
    return this.backend.refreshVisibility(jobId, timeout);
  }

  /**
   * Get the underlying backend (for advanced operations).
   */
  getBackend(): QueueBackend {
    return this.backend;
  }

  // ============ Metrics Emission ============

  private startMetricsEmission(): void {
    if (this.metricsInterval) return;

    this.metricsInterval = setInterval(async () => {
      try {
        const metrics = await this.collectMetrics();
        this.emit('metrics:snapshot', metrics);
      } catch {
        // Ignore metrics collection errors
      }
    }, this.config.metricsIntervalMs);
  }

  private stopMetricsEmission(): void {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
      this.metricsInterval = undefined;
    }
  }

  private async collectMetrics(): Promise<SchedulerMetrics> {
    const stats = await this.getQueueStats();

    return {
      timestamp: Date.now(),
      queueDepth: stats.queueDepth,
      processing: stats.processing,
      deadLetter: stats.deadLetter,
      // These would need tracking over time - simplified for now
      completedLastMinute: 0,
      failedLastMinute: 0,
      avgProcessingTimeMs: 0,
    };
  }
}
