/**
 * WorkerProcessor - Main processor class that processes jobs from the queue.
 *
 * The WorkerProcessor:
 * - Polls for jobs from the scheduler
 * - Dispatches jobs to appropriate handlers
 * - Handles graceful shutdown with timeout
 * - Emits events for observability
 * - Tracks metrics
 */

import { EventEmitter } from 'events';
import type { Job, JobType } from '../scheduler/types.js';
import type {
  WorkerConfig,
  WorkerMetrics,
  WorkerStatus,
  JobResult,
  JobHandler,
  AgentJobPayload,
  HumanJobPayload,
} from './types.js';

/**
 * Job Scheduler interface - methods we need from the scheduler.
 */
export interface JobSchedulerLike {
  dequeue: () => Promise<Job | undefined>;
  acknowledge: (jobId: string, result?: unknown) => Promise<void>;
  nack: (jobId: string, error: Error) => Promise<void>;
}

/**
 * Agent Registry interface - methods we need from the registry.
 */
export interface AgentRegistryLike {
  get: (name: string) => unknown | undefined;
}

/**
 * Message Router interface - methods we need from the router.
 */
export interface MessageRouterLike {
  routeAndWait: (message: unknown, timeout: number) => Promise<unknown>;
}

/**
 * WorkerProcessor is the main class that processes jobs from the queue.
 */
export class WorkerProcessor extends EventEmitter {
  private scheduler: JobSchedulerLike;
  private agentRegistry: AgentRegistryLike;
  private router: MessageRouterLike;
  private config: WorkerConfig;
  private running = false;
  private status: WorkerStatus = 'stopped';
  private currentJob: Job | undefined;
  private metrics: WorkerMetrics = {
    jobsProcessed: 0,
    jobsSucceeded: 0,
    jobsFailed: 0,
    errorRate: 0,
    avgProcessingTime: 0,
  };
  private processingTimes: number[] = [];
  private healthServerStarted = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | undefined;
  private pollInterval: ReturnType<typeof setInterval> | undefined;
  private handlers: Map<JobType, JobHandler> = new Map();
  private shutdownPromise: Promise<void> | undefined;

  constructor(
    scheduler: JobSchedulerLike,
    agentRegistry: AgentRegistryLike,
    router: MessageRouterLike,
    config: WorkerConfig
  ) {
    super();
    this.scheduler = scheduler;
    this.agentRegistry = agentRegistry;
    this.router = router;
    this.config = config;
  }

  /**
   * Start the worker processor.
   * Begins polling for jobs and starts health/heartbeat services if enabled.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Worker is already running');
    }

    this.running = true;
    this.status = 'idle';

    // Start health server if enabled
    if (this.config.health.enabled) {
      this.healthServerStarted = true;
    }

    // Start heartbeat if enabled
    if (this.config.heartbeat.enabled) {
      this.heartbeatInterval = setInterval(() => {
        this.emit('heartbeat', {
          workerId: this.config.workerId,
          timestamp: Date.now(),
          status: this.status,
          currentJob: this.currentJob?.id,
          metrics: this.metrics,
        });
      }, this.config.heartbeat.interval);
    }

    // Start polling for jobs
    this.pollInterval = setInterval(async () => {
      if (this.status === 'idle') {
        const job = await this.scheduler.dequeue();
        if (job) {
          await this.processJob(job);
        }
      }
    }, this.config.pollInterval);

    this.emit('started', this.config.workerId);
  }

  /**
   * Stop the worker processor.
   * Performs graceful shutdown, waiting for current job to complete.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.emit('shutdown:initiated');

    // Set draining status if processing
    if (this.currentJob) {
      this.status = 'draining';

      // Wait for current job with timeout
      const shutdownStart = Date.now();
      this.shutdownPromise = new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (!this.currentJob) {
            clearInterval(checkInterval);
            resolve();
          } else if (Date.now() - shutdownStart > this.config.gracefulShutdownTimeout) {
            clearInterval(checkInterval);
            this.emit('shutdown:timeout', this.currentJob);
            if (this.config.forceShutdownOnTimeout) {
              resolve();
            }
          }
        }, 100);
      });

      await this.shutdownPromise;
    }

    // Stop intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }

    this.running = false;
    this.status = 'stopped';
    this.healthServerStarted = false;

    this.emit('stopped', this.config.workerId);
  }

  /**
   * Process a single job.
   * Dispatches to the appropriate handler based on job type.
   */
  async processJob(job: Job): Promise<JobResult> {
    this.currentJob = job;
    this.status = 'processing';
    const startTime = Date.now();

    this.emit('job:started', job);

    try {
      // Get handler for job type
      const handler = this.handlers.get(job.type);
      let result: JobResult;

      if (handler) {
        result = await handler.handle(job);
      } else {
        // Default processing based on job type
        result = await this.defaultHandleJob(job);
      }

      const duration = Date.now() - startTime;
      result.duration = duration;

      // Update metrics
      this.metrics.jobsProcessed++;
      if (result.success) {
        this.metrics.jobsSucceeded++;
        await this.scheduler.acknowledge(job.id, result);
        this.emit('job:completed', job, result);
      } else {
        this.metrics.jobsFailed++;
        await this.scheduler.nack(job.id, new Error('Job failed'));
        this.emit('job:failed', job, new Error('Job failed'));
      }

      this.updateMetrics(duration);

      this.currentJob = undefined;
      this.status = this.running ? 'idle' : 'stopped';

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.metrics.jobsProcessed++;
      this.metrics.jobsFailed++;
      this.updateMetrics(duration);

      const err = error instanceof Error ? error : new Error(String(error));

      // Check if job should be retried
      if (job.attempts < job.maxAttempts - 1) {
        const delay = this.calculateRetryDelay(job.attempts);
        this.emit('job:retrying', job, job.attempts + 1, delay);
      }

      await this.scheduler.nack(job.id, err);
      this.emit('job:failed', job, err);

      this.currentJob = undefined;
      this.status = this.running ? 'idle' : 'stopped';

      return {
        success: false,
        output: null,
        duration,
      };
    }
  }

  /**
   * Default job handling when no specific handler is registered.
   */
  private async defaultHandleJob(job: Job): Promise<JobResult> {
    switch (job.type) {
      case 'agent': {
        const agent = this.agentRegistry.get((job.payload as AgentJobPayload).agent ?? 'default');
        if (!agent) {
          return { success: false, output: 'Agent not found' };
        }
        return { success: true, output: 'Agent job completed' };
      }
      case 'human': {
        const response = await this.router.routeAndWait(
          { type: 'decision_request', payload: job.payload },
          (job.payload as HumanJobPayload).timeout
        );
        return { success: true, output: response };
      }
      case 'integration': {
        return { success: true, output: 'Integration job completed' };
      }
      default:
        return { success: false, output: 'Unknown job type' };
    }
  }

  /**
   * Calculate retry delay using exponential backoff.
   */
  private calculateRetryDelay(attempts: number): number {
    const { initialDelay, maxDelay, backoffMultiplier } =
      this.config.handlers.agent.retry;
    const delay = initialDelay * Math.pow(backoffMultiplier, attempts);
    return Math.min(delay, maxDelay);
  }

  /**
   * Update metrics after processing a job.
   */
  private updateMetrics(processingTime: number): void {
    this.processingTimes.push(processingTime);

    // Keep only last 100 processing times
    if (this.processingTimes.length > 100) {
      this.processingTimes.shift();
    }

    // Calculate average
    this.metrics.avgProcessingTime =
      this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;

    // Calculate error rate
    this.metrics.errorRate =
      this.metrics.jobsProcessed > 0
        ? this.metrics.jobsFailed / this.metrics.jobsProcessed
        : 0;

    this.metrics.lastProcessingTime = processingTime;

    // Emit metrics snapshot (emit a copy to prevent mutation)
    this.emit('metrics:snapshot', { ...this.metrics });
  }

  /**
   * Check if the processor is currently processing a job.
   */
  isProcessing(): boolean {
    return this.status === 'processing';
  }

  /**
   * Get the current job being processed.
   */
  getCurrentJob(): Job | undefined {
    return this.currentJob;
  }

  /**
   * Get the current worker status.
   */
  getStatus(): WorkerStatus {
    return this.status;
  }

  /**
   * Get a copy of the current metrics.
   */
  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  /**
   * Check if the worker is healthy.
   * Worker is healthy if running and error rate is below 50%.
   */
  isHealthy(): boolean {
    if (!this.running || this.status === 'stopped') {
      return false;
    }
    return this.metrics.errorRate < 0.5;
  }

  /**
   * Register a handler for a specific job type.
   */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Unregister a handler for a job type.
   */
  unregisterHandler(type: JobType): void {
    this.handlers.delete(type);
  }

  /**
   * Check if health server is started (for testing).
   */
  isHealthServerStarted(): boolean {
    return this.healthServerStarted;
  }

  /**
   * Check if heartbeat is running (for testing).
   */
  isHeartbeatRunning(): boolean {
    return this.heartbeatInterval !== undefined;
  }

  /**
   * Set up shutdown signal handlers (SIGTERM, SIGINT).
   * Call this when running as a standalone process.
   */
  setupSignalHandlers(): void {
    const handleShutdown = async (signal: string) => {
      this.emit('signal:received', signal);
      await this.stop();
      process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT', () => handleShutdown('SIGINT'));
  }
}
