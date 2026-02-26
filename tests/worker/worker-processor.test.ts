/**
 * Tests for the WorkerProcessor lifecycle.
 *
 * Tests cover:
 * - Constructor and initialization
 * - start() and stop() lifecycle methods
 * - processJob() job dispatching
 * - Status methods (isProcessing, getCurrentJob, getStatus)
 * - Metrics tracking
 * - Event emissions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Job, JobType } from '../../src/scheduler/types.js';
import type {
  WorkerConfig,
  WorkerMetrics,
  WorkerStatus,
  JobResult,
  JobHandler,
  AgentJobPayload,
  HumanJobPayload,
  IntegrationJobPayload,
} from '../../src/worker/types.js';
import { DEFAULT_WORKER_CONFIG } from '../../src/worker/config/worker-config.js';

// ============ Mock Interfaces ============

/** Mock JobScheduler interface for testing */
interface MockJobScheduler {
  dequeue: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
  getJob: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
}

/** Mock AgentRegistry interface for testing */
interface MockAgentRegistry {
  get: ReturnType<typeof vi.fn>;
  getDefault: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

/** Mock MessageRouter interface for testing */
interface MockMessageRouter {
  correlationManager: {
    correlate: ReturnType<typeof vi.fn>;
    waitForCorrelation: ReturnType<typeof vi.fn>;
  };
  route: ReturnType<typeof vi.fn>;
  routeAndWait: ReturnType<typeof vi.fn>;
}

// ============ Test Helpers ============

/**
 * Create a mock JobScheduler for testing.
 */
function createMockScheduler(): MockJobScheduler {
  return {
    dequeue: vi.fn().mockResolvedValue(undefined),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
    getJob: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    resume: vi.fn(),
  };
}

/**
 * Create a mock AgentRegistry for testing.
 */
function createMockAgentRegistry(): MockAgentRegistry {
  return {
    get: vi.fn().mockReturnValue(undefined),
    getDefault: vi.fn().mockReturnValue(undefined),
    list: vi.fn().mockReturnValue([]),
  };
}

/**
 * Create a mock MessageRouter for testing.
 */
function createMockRouter(): MockMessageRouter {
  return {
    correlationManager: {
      correlate: vi.fn(),
      waitForCorrelation: vi.fn().mockResolvedValue(undefined),
    },
    route: vi.fn().mockResolvedValue(undefined),
    routeAndWait: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Create a test job with given overrides.
 */
function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    workflowId: 'workflow-test-1',
    stepId: 'step-1',
    type: 'agent',
    status: 'pending',
    priority: 'normal',
    attempts: 0,
    maxAttempts: 3,
    payload: { command: 'test' } as AgentJobPayload,
    createdAt: new Date().toISOString(),
    visibilityTimeout: 30000,
    ...overrides,
  };
}

/**
 * Create a test configuration with given overrides.
 */
function createTestConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...DEFAULT_WORKER_CONFIG,
    workerId: 'test-worker-1',
    health: {
      ...DEFAULT_WORKER_CONFIG.health,
      enabled: false, // Disable health server for tests
    },
    heartbeat: {
      ...DEFAULT_WORKER_CONFIG.heartbeat,
      enabled: false, // Disable heartbeat for faster tests
    },
    ...overrides,
  };
}

// ============ WorkerProcessor Class (to be implemented) ============

/**
 * WorkerProcessor is the main class that processes jobs from the queue.
 * This is a placeholder interface - the actual class will be implemented
 * in src/worker/worker-processor.ts
 */
interface WorkerProcessorInterface extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  processJob(job: Job): Promise<JobResult>;
  isProcessing(): boolean;
  getCurrentJob(): Job | undefined;
  getStatus(): WorkerStatus;
  getMetrics(): WorkerMetrics;
  isHealthy(): boolean;
}

// Import will work once the class is implemented
// import { WorkerProcessor } from '../../src/worker/worker-processor.js';

// For now, we'll create a minimal stub to demonstrate the test structure
// The actual implementation should match this interface
class WorkerProcessor extends EventEmitter implements WorkerProcessorInterface {
  private scheduler: MockJobScheduler;
  private agentRegistry: MockAgentRegistry;
  private router: MockMessageRouter;
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
    scheduler: MockJobScheduler,
    agentRegistry: MockAgentRegistry,
    router: MockMessageRouter,
    config: WorkerConfig
  ) {
    super();
    this.scheduler = scheduler;
    this.agentRegistry = agentRegistry;
    this.router = router;
    this.config = config;
  }

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

  private async defaultHandleJob(job: Job): Promise<JobResult> {
    // Placeholder implementation
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

  private calculateRetryDelay(attempts: number): number {
    const { initialDelay, maxDelay, backoffMultiplier } =
      this.config.handlers.agent.retry;
    const delay = initialDelay * Math.pow(backoffMultiplier, attempts);
    return Math.min(delay, maxDelay);
  }

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

  isProcessing(): boolean {
    return this.status === 'processing';
  }

  getCurrentJob(): Job | undefined {
    return this.currentJob;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getMetrics(): WorkerMetrics {
    return { ...this.metrics };
  }

  isHealthy(): boolean {
    // Worker is healthy if:
    // 1. It's running and not stopped
    // 2. Error rate is below threshold (e.g., 50%)
    if (!this.running || this.status === 'stopped') {
      return false;
    }
    return this.metrics.errorRate < 0.5;
  }

  /** Register a handler for a specific job type */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Unregister a handler */
  unregisterHandler(type: JobType): void {
    this.handlers.delete(type);
  }

  /** Check if health server is started (for testing) */
  isHealthServerStarted(): boolean {
    return this.healthServerStarted;
  }

  /** Check if heartbeat is running (for testing) */
  isHeartbeatRunning(): boolean {
    return this.heartbeatInterval !== undefined;
  }
}

// ============ Test Suites ============

describe('WorkerProcessor', () => {
  let processor: WorkerProcessor;
  let scheduler: MockJobScheduler;
  let agentRegistry: MockAgentRegistry;
  let router: MockMessageRouter;
  let config: WorkerConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = createMockScheduler();
    agentRegistry = createMockAgentRegistry();
    router = createMockRouter();
    config = createTestConfig();
    processor = new WorkerProcessor(scheduler, agentRegistry, router, config);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (processor.getStatus() !== 'stopped') {
      await processor.stop();
    }
    vi.clearAllMocks();
  });

  // ============ Constructor Tests ============

  describe('constructor', () => {
    it('should create a WorkerProcessor with required dependencies', () => {
      expect(processor).toBeDefined();
      expect(processor).toBeInstanceOf(EventEmitter);
    });

    it('should initialize with stopped status', () => {
      expect(processor.getStatus()).toBe('stopped');
    });

    it('should initialize with zero metrics', () => {
      const metrics = processor.getMetrics();
      expect(metrics.jobsProcessed).toBe(0);
      expect(metrics.jobsSucceeded).toBe(0);
      expect(metrics.jobsFailed).toBe(0);
      expect(metrics.errorRate).toBe(0);
      expect(metrics.avgProcessingTime).toBe(0);
    });

    it('should not be processing initially', () => {
      expect(processor.isProcessing()).toBe(false);
    });

    it('should not have a current job initially', () => {
      expect(processor.getCurrentJob()).toBeUndefined();
    });

    it('should not be healthy when stopped', () => {
      expect(processor.isHealthy()).toBe(false);
    });
  });

  // ============ start() Tests ============

  describe('start()', () => {
    it('should set running state to idle', async () => {
      await processor.start();
      expect(processor.getStatus()).toBe('idle');
    });

    it('should emit started event with workerId', async () => {
      const startedHandler = vi.fn();
      processor.on('started', startedHandler);

      await processor.start();

      expect(startedHandler).toHaveBeenCalledTimes(1);
      expect(startedHandler).toHaveBeenCalledWith(config.workerId);
    });

    it('should throw error if already running', async () => {
      await processor.start();
      await expect(processor.start()).rejects.toThrow('Worker is already running');
    });

    it('should start health server when enabled', async () => {
      const healthConfig = createTestConfig({
        health: { enabled: true, port: 3001 },
      });
      const healthProcessor = new WorkerProcessor(
        scheduler,
        agentRegistry,
        router,
        healthConfig
      );

      await healthProcessor.start();
      expect(healthProcessor.isHealthServerStarted()).toBe(true);

      await healthProcessor.stop();
    });

    it('should not start health server when disabled', async () => {
      await processor.start();
      expect(processor.isHealthServerStarted()).toBe(false);
    });

    it('should start heartbeat when enabled', async () => {
      const heartbeatConfig = createTestConfig({
        heartbeat: { enabled: true, interval: 1000, ttl: 5000 },
      });
      const heartbeatProcessor = new WorkerProcessor(
        scheduler,
        agentRegistry,
        router,
        heartbeatConfig
      );

      await heartbeatProcessor.start();
      expect(heartbeatProcessor.isHeartbeatRunning()).toBe(true);

      await heartbeatProcessor.stop();
    });

    it('should not start heartbeat when disabled', async () => {
      await processor.start();
      expect(processor.isHeartbeatRunning()).toBe(false);
    });

    it('should be healthy after starting', async () => {
      await processor.start();
      expect(processor.isHealthy()).toBe(true);
    });

    it('should start polling for jobs', async () => {
      const job = createTestJob();
      scheduler.dequeue.mockResolvedValueOnce(job);

      const jobStartedHandler = vi.fn();
      processor.on('job:started', jobStartedHandler);

      await processor.start();

      // Advance timer past poll interval
      await vi.advanceTimersByTimeAsync(config.pollInterval + 10);

      expect(scheduler.dequeue).toHaveBeenCalled();
    });
  });

  // ============ stop() Tests ============

  describe('stop()', () => {
    it('should set status to stopped', async () => {
      await processor.start();
      await processor.stop();
      expect(processor.getStatus()).toBe('stopped');
    });

    it('should emit stopped event with workerId', async () => {
      const stoppedHandler = vi.fn();
      processor.on('stopped', stoppedHandler);

      await processor.start();
      await processor.stop();

      expect(stoppedHandler).toHaveBeenCalledTimes(1);
      expect(stoppedHandler).toHaveBeenCalledWith(config.workerId);
    });

    it('should emit shutdown:initiated event', async () => {
      const shutdownHandler = vi.fn();
      processor.on('shutdown:initiated', shutdownHandler);

      await processor.start();
      await processor.stop();

      expect(shutdownHandler).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if not running', async () => {
      const stoppedHandler = vi.fn();
      processor.on('stopped', stoppedHandler);

      await processor.stop();

      expect(stoppedHandler).not.toHaveBeenCalled();
    });

    it('should stop heartbeat interval', async () => {
      const heartbeatConfig = createTestConfig({
        heartbeat: { enabled: true, interval: 1000, ttl: 5000 },
      });
      const heartbeatProcessor = new WorkerProcessor(
        scheduler,
        agentRegistry,
        router,
        heartbeatConfig
      );

      await heartbeatProcessor.start();
      expect(heartbeatProcessor.isHeartbeatRunning()).toBe(true);

      await heartbeatProcessor.stop();
      expect(heartbeatProcessor.isHeartbeatRunning()).toBe(false);
    });

    it('should stop health server', async () => {
      const healthConfig = createTestConfig({
        health: { enabled: true, port: 3001 },
      });
      const healthProcessor = new WorkerProcessor(
        scheduler,
        agentRegistry,
        router,
        healthConfig
      );

      await healthProcessor.start();
      await healthProcessor.stop();

      expect(healthProcessor.isHealthServerStarted()).toBe(false);
    });

    it('should not be healthy after stopping', async () => {
      await processor.start();
      expect(processor.isHealthy()).toBe(true);

      await processor.stop();
      expect(processor.isHealthy()).toBe(false);
    });

    describe('graceful shutdown with current job', () => {
      it('should set status to draining when job is processing', async () => {
        vi.useRealTimers();
        const slowProcessor = new WorkerProcessor(
          scheduler,
          agentRegistry,
          router,
          createTestConfig({
            gracefulShutdownTimeout: 5000,
          })
        );

        await slowProcessor.start();

        // Start processing a job
        const job = createTestJob();
        const processPromise = slowProcessor.processJob(job);

        // Check status immediately
        expect(slowProcessor.getStatus()).toBe('processing');

        // Start stop (will wait for job)
        const stopPromise = slowProcessor.stop();

        // Status should be draining
        expect(slowProcessor.getStatus()).toBe('draining');

        // Wait for job to complete
        await processPromise;
        await stopPromise;

        expect(slowProcessor.getStatus()).toBe('stopped');
      });

      it('should wait for current job to complete before stopping', async () => {
        vi.useRealTimers();
        const slowProcessor = new WorkerProcessor(
          scheduler,
          agentRegistry,
          router,
          createTestConfig({
            gracefulShutdownTimeout: 5000,
          })
        );

        await slowProcessor.start();

        const job = createTestJob();
        const processPromise = slowProcessor.processJob(job);

        const stopStart = Date.now();
        const stopPromise = slowProcessor.stop();

        // Wait for both
        await Promise.all([processPromise, stopPromise]);

        expect(slowProcessor.getStatus()).toBe('stopped');
        expect(slowProcessor.getCurrentJob()).toBeUndefined();
      });

      it('should emit shutdown:timeout if job takes too long', async () => {
        vi.useRealTimers();
        const shortTimeoutConfig = createTestConfig({
          gracefulShutdownTimeout: 100,
          forceShutdownOnTimeout: true,
        });
        const timeoutProcessor = new WorkerProcessor(
          scheduler,
          agentRegistry,
          router,
          shortTimeoutConfig
        );

        // Create a handler that takes longer than timeout
        const slowHandler: JobHandler = {
          handle: async (job: Job): Promise<JobResult> => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return { success: true, output: 'done' };
          },
        };
        timeoutProcessor.registerHandler('agent', slowHandler);

        const timeoutHandler = vi.fn();
        timeoutProcessor.on('shutdown:timeout', timeoutHandler);

        await timeoutProcessor.start();

        const job = createTestJob({ type: 'agent' });
        const processPromise = timeoutProcessor.processJob(job);

        // Start stop immediately
        const stopPromise = timeoutProcessor.stop();

        // Wait for stop (should timeout)
        await stopPromise;

        expect(timeoutHandler).toHaveBeenCalled();
        expect(timeoutHandler.mock.calls[0][0]).toBe(job);

        // Clean up
        await processPromise.catch(() => {}); // Ignore any errors
      });
    });
  });

  // ============ processJob() Tests ============

  describe('processJob()', () => {
    beforeEach(async () => {
      await processor.start();
    });

    it('should set status to processing', async () => {
      vi.useRealTimers();
      const localProcessor = new WorkerProcessor(
        createMockScheduler(),
        createMockAgentRegistry(),
        createMockRouter(),
        createTestConfig()
      );
      await localProcessor.start();

      const job = createTestJob();

      // Check status during processing
      let statusDuringProcessing: WorkerStatus | undefined;
      localProcessor.on('job:started', () => {
        statusDuringProcessing = localProcessor.getStatus();
      });

      await localProcessor.processJob(job);

      expect(statusDuringProcessing).toBe('processing');
      await localProcessor.stop();
    });

    it('should set currentJob during processing', async () => {
      vi.useRealTimers();
      const localProcessor = new WorkerProcessor(
        createMockScheduler(),
        createMockAgentRegistry(),
        createMockRouter(),
        createTestConfig()
      );
      await localProcessor.start();

      const job = createTestJob();

      let currentJobDuringProcessing: Job | undefined;
      localProcessor.on('job:started', () => {
        currentJobDuringProcessing = localProcessor.getCurrentJob();
      });

      await localProcessor.processJob(job);

      expect(currentJobDuringProcessing).toBe(job);
      await localProcessor.stop();
    });

    it('should emit job:started event', async () => {
      const jobStartedHandler = vi.fn();
      processor.on('job:started', jobStartedHandler);

      const job = createTestJob();
      await processor.processJob(job);

      expect(jobStartedHandler).toHaveBeenCalledTimes(1);
      expect(jobStartedHandler).toHaveBeenCalledWith(job);
    });

    it('should emit job:completed event on success', async () => {
      const jobCompletedHandler = vi.fn();
      processor.on('job:completed', jobCompletedHandler);

      const successHandler: JobHandler = {
        handle: async (): Promise<JobResult> => ({
          success: true,
          output: 'test output',
        }),
      };
      processor.registerHandler('agent', successHandler);

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(jobCompletedHandler).toHaveBeenCalledTimes(1);
      expect(jobCompletedHandler.mock.calls[0][0]).toBe(job);
      expect(jobCompletedHandler.mock.calls[0][1]).toMatchObject({
        success: true,
        output: 'test output',
      });
    });

    it('should emit job:failed event on failure', async () => {
      const jobFailedHandler = vi.fn();
      processor.on('job:failed', jobFailedHandler);

      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Test error');
        },
      };
      processor.registerHandler('agent', failHandler);

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(jobFailedHandler).toHaveBeenCalledTimes(1);
      expect(jobFailedHandler.mock.calls[0][0]).toBe(job);
      expect(jobFailedHandler.mock.calls[0][1]).toBeInstanceOf(Error);
      expect(jobFailedHandler.mock.calls[0][1].message).toBe('Test error');
    });

    it('should emit job:retrying event when job can be retried', async () => {
      const jobRetryingHandler = vi.fn();
      processor.on('job:retrying', jobRetryingHandler);

      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Retryable error');
        },
      };
      processor.registerHandler('agent', failHandler);

      const job = createTestJob({
        type: 'agent',
        attempts: 0,
        maxAttempts: 3,
      });
      await processor.processJob(job);

      expect(jobRetryingHandler).toHaveBeenCalledTimes(1);
      expect(jobRetryingHandler.mock.calls[0][0]).toBe(job);
      expect(jobRetryingHandler.mock.calls[0][1]).toBe(1); // attempt number
      expect(typeof jobRetryingHandler.mock.calls[0][2]).toBe('number'); // delay
    });

    it('should not emit job:retrying when max attempts reached', async () => {
      const jobRetryingHandler = vi.fn();
      processor.on('job:retrying', jobRetryingHandler);

      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Final error');
        },
      };
      processor.registerHandler('agent', failHandler);

      const job = createTestJob({
        type: 'agent',
        attempts: 2,
        maxAttempts: 3, // Already at max attempts
      });
      await processor.processJob(job);

      expect(jobRetryingHandler).not.toHaveBeenCalled();
    });

    it('should acknowledge job on success', async () => {
      const successHandler: JobHandler = {
        handle: async (): Promise<JobResult> => ({
          success: true,
          output: 'success',
        }),
      };
      processor.registerHandler('agent', successHandler);

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(scheduler.acknowledge).toHaveBeenCalledWith(job.id, expect.any(Object));
    });

    it('should nack job on failure', async () => {
      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Test error');
        },
      };
      processor.registerHandler('agent', failHandler);

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(scheduler.nack).toHaveBeenCalledWith(job.id, expect.any(Error));
    });

    it('should return JobResult with duration', async () => {
      vi.useRealTimers();
      const localProcessor = new WorkerProcessor(
        createMockScheduler(),
        createMockAgentRegistry(),
        createMockRouter(),
        createTestConfig()
      );
      await localProcessor.start();

      const successHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { success: true, output: 'done' };
        },
      };
      localProcessor.registerHandler('agent', successHandler);

      const job = createTestJob({ type: 'agent' });
      const result = await localProcessor.processJob(job);

      expect(result.duration).toBeDefined();
      // Use a more lenient threshold since setTimeout is not always precise
      expect(result.duration).toBeGreaterThanOrEqual(15);

      await localProcessor.stop();
    });

    it('should clear currentJob after processing', async () => {
      const job = createTestJob();
      await processor.processJob(job);

      expect(processor.getCurrentJob()).toBeUndefined();
    });

    it('should return to idle status after processing', async () => {
      const job = createTestJob();
      await processor.processJob(job);

      expect(processor.getStatus()).toBe('idle');
    });

    describe('job type dispatching', () => {
      it('should dispatch agent jobs to agent handler', async () => {
        const agentHandler: JobHandler = {
          handle: vi.fn().mockResolvedValue({ success: true, output: 'agent' }),
        };
        processor.registerHandler('agent', agentHandler);

        const job = createTestJob({ type: 'agent' });
        await processor.processJob(job);

        expect(agentHandler.handle).toHaveBeenCalledWith(job);
      });

      it('should dispatch human jobs to human handler', async () => {
        const humanHandler: JobHandler = {
          handle: vi.fn().mockResolvedValue({ success: true, output: 'human' }),
        };
        processor.registerHandler('human', humanHandler);

        const job = createTestJob({
          type: 'human',
          payload: {
            type: 'approval',
            title: 'Test',
            description: 'Test description',
            urgency: 'normal',
            timeout: 60000,
          } as HumanJobPayload,
        });
        await processor.processJob(job);

        expect(humanHandler.handle).toHaveBeenCalledWith(job);
      });

      it('should dispatch integration jobs to integration handler', async () => {
        const integrationHandler: JobHandler = {
          handle: vi.fn().mockResolvedValue({ success: true, output: 'integration' }),
        };
        processor.registerHandler('integration', integrationHandler);

        const job = createTestJob({
          type: 'integration',
          payload: {
            integration: 'github',
            action: 'create-pr',
            params: {},
          } as IntegrationJobPayload,
        });
        await processor.processJob(job);

        expect(integrationHandler.handle).toHaveBeenCalledWith(job);
      });

      it('should use default handling when no handler registered', async () => {
        const job = createTestJob({ type: 'agent' });
        const result = await processor.processJob(job);

        // Default handling should still return a result
        expect(result).toHaveProperty('success');
        expect(result).toHaveProperty('output');
      });
    });
  });

  // ============ Status Methods Tests ============

  describe('status methods', () => {
    describe('isProcessing()', () => {
      it('should return false when idle', async () => {
        await processor.start();
        expect(processor.isProcessing()).toBe(false);
      });

      it('should return true when processing a job', async () => {
        vi.useRealTimers();
        const localProcessor = new WorkerProcessor(
          createMockScheduler(),
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig()
        );
        await localProcessor.start();

        let isProcessingDuringJob = false;
        localProcessor.on('job:started', () => {
          isProcessingDuringJob = localProcessor.isProcessing();
        });

        await localProcessor.processJob(createTestJob());

        expect(isProcessingDuringJob).toBe(true);
        await localProcessor.stop();
      });

      it('should return false when stopped', () => {
        expect(processor.isProcessing()).toBe(false);
      });
    });

    describe('getCurrentJob()', () => {
      it('should return undefined when not processing', async () => {
        await processor.start();
        expect(processor.getCurrentJob()).toBeUndefined();
      });

      it('should return current job during processing', async () => {
        vi.useRealTimers();
        const localProcessor = new WorkerProcessor(
          createMockScheduler(),
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig()
        );
        await localProcessor.start();

        const job = createTestJob();
        let currentJobDuringProcessing: Job | undefined;

        localProcessor.on('job:started', () => {
          currentJobDuringProcessing = localProcessor.getCurrentJob();
        });

        await localProcessor.processJob(job);

        expect(currentJobDuringProcessing?.id).toBe(job.id);
        await localProcessor.stop();
      });
    });

    describe('getStatus()', () => {
      it('should return stopped initially', () => {
        expect(processor.getStatus()).toBe('stopped');
      });

      it('should return idle after start', async () => {
        await processor.start();
        expect(processor.getStatus()).toBe('idle');
      });

      it('should return processing during job', async () => {
        vi.useRealTimers();
        const localProcessor = new WorkerProcessor(
          createMockScheduler(),
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig()
        );
        await localProcessor.start();

        let statusDuringJob: WorkerStatus | undefined;
        localProcessor.on('job:started', () => {
          statusDuringJob = localProcessor.getStatus();
        });

        await localProcessor.processJob(createTestJob());

        expect(statusDuringJob).toBe('processing');
        await localProcessor.stop();
      });

      it('should return draining during graceful shutdown with active job', async () => {
        vi.useRealTimers();
        const localScheduler = createMockScheduler();
        const localProcessor = new WorkerProcessor(
          localScheduler,
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig({ gracefulShutdownTimeout: 5000 })
        );

        // Create a slow handler to ensure job is still processing when stop is called
        const slowHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { success: true, output: 'done' };
          },
        };
        localProcessor.registerHandler('agent', slowHandler);

        await localProcessor.start();

        const job = createTestJob({ type: 'agent' });

        // Start processing the job (don't await)
        const processPromise = localProcessor.processJob(job);

        // Wait a tiny bit for job to start
        await new Promise((resolve) => setTimeout(resolve, 10));

        // Call stop while job is still processing
        const stopPromise = localProcessor.stop();

        // Check status immediately after stop is called but before it completes
        const statusDuringShutdown = localProcessor.getStatus();

        await Promise.all([processPromise, stopPromise]);

        expect(statusDuringShutdown).toBe('draining');
      });

      it('should return stopped after stop', async () => {
        await processor.start();
        await processor.stop();
        expect(processor.getStatus()).toBe('stopped');
      });
    });
  });

  // ============ Metrics Tests ============

  describe('metrics tracking', () => {
    beforeEach(async () => {
      await processor.start();
    });

    describe('getMetrics()', () => {
      it('should return a copy of metrics', () => {
        const metrics1 = processor.getMetrics();
        const metrics2 = processor.getMetrics();

        expect(metrics1).toEqual(metrics2);
        expect(metrics1).not.toBe(metrics2); // Different object references
      });

      it('should track jobsProcessed', async () => {
        await processor.processJob(createTestJob());
        await processor.processJob(createTestJob());

        const metrics = processor.getMetrics();
        expect(metrics.jobsProcessed).toBe(2);
      });

      it('should track jobsSucceeded', async () => {
        const successHandler: JobHandler = {
          handle: async (): Promise<JobResult> => ({
            success: true,
            output: 'success',
          }),
        };
        processor.registerHandler('agent', successHandler);

        await processor.processJob(createTestJob({ type: 'agent' }));
        await processor.processJob(createTestJob({ type: 'agent' }));

        const metrics = processor.getMetrics();
        expect(metrics.jobsSucceeded).toBe(2);
      });

      it('should track jobsFailed', async () => {
        const failHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            throw new Error('Failed');
          },
        };
        processor.registerHandler('agent', failHandler);

        await processor.processJob(createTestJob({ type: 'agent' }));
        await processor.processJob(createTestJob({ type: 'agent' }));

        const metrics = processor.getMetrics();
        expect(metrics.jobsFailed).toBe(2);
      });

      it('should calculate errorRate correctly', async () => {
        const successHandler: JobHandler = {
          handle: async (): Promise<JobResult> => ({
            success: true,
            output: 'success',
          }),
        };
        const failHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            throw new Error('Failed');
          },
        };

        processor.registerHandler('agent', successHandler);
        await processor.processJob(createTestJob({ type: 'agent' }));
        await processor.processJob(createTestJob({ type: 'agent' }));

        processor.registerHandler('agent', failHandler);
        await processor.processJob(createTestJob({ type: 'agent' }));

        const metrics = processor.getMetrics();
        expect(metrics.jobsProcessed).toBe(3);
        expect(metrics.jobsFailed).toBe(1);
        expect(metrics.errorRate).toBeCloseTo(1 / 3, 5);
      });

      it('should calculate avgProcessingTime', async () => {
        vi.useRealTimers();
        const localScheduler = createMockScheduler();
        const localProcessor = new WorkerProcessor(
          localScheduler,
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig()
        );
        await localProcessor.start();

        const slowHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { success: true, output: 'done' };
          },
        };
        localProcessor.registerHandler('agent', slowHandler);

        await localProcessor.processJob(createTestJob({ type: 'agent' }));

        const metrics = localProcessor.getMetrics();
        expect(metrics.avgProcessingTime).toBeGreaterThanOrEqual(50);

        await localProcessor.stop();
      });

      it('should track lastProcessingTime', async () => {
        vi.useRealTimers();
        const localProcessor = new WorkerProcessor(
          createMockScheduler(),
          createMockAgentRegistry(),
          createMockRouter(),
          createTestConfig()
        );
        await localProcessor.start();

        const handler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            return { success: true, output: 'done' };
          },
        };
        localProcessor.registerHandler('agent', handler);

        await localProcessor.processJob(createTestJob({ type: 'agent' }));

        const metrics = localProcessor.getMetrics();
        expect(metrics.lastProcessingTime).toBeDefined();
        // Use a more lenient threshold since setTimeout is not always precise
        expect(metrics.lastProcessingTime).toBeGreaterThanOrEqual(25);

        await localProcessor.stop();
      });
    });

    describe('metrics:snapshot event', () => {
      it('should emit metrics:snapshot after each job', async () => {
        const metricsHandler = vi.fn();
        processor.on('metrics:snapshot', metricsHandler);

        await processor.processJob(createTestJob());

        expect(metricsHandler).toHaveBeenCalled();
        expect(metricsHandler.mock.calls[0][0]).toHaveProperty('jobsProcessed');
        expect(metricsHandler.mock.calls[0][0]).toHaveProperty('avgProcessingTime');
      });

      it('should emit updated metrics after multiple jobs', async () => {
        const metricsSnapshots: WorkerMetrics[] = [];
        processor.on('metrics:snapshot', (metrics: WorkerMetrics) => {
          // Store a copy since getMetrics returns a new object each time
          // but emit might pass the same object reference
          metricsSnapshots.push({ ...metrics });
        });

        await processor.processJob(createTestJob());
        await processor.processJob(createTestJob());
        await processor.processJob(createTestJob());

        expect(metricsSnapshots).toHaveLength(3);
        expect(metricsSnapshots[0].jobsProcessed).toBe(1);
        expect(metricsSnapshots[1].jobsProcessed).toBe(2);
        expect(metricsSnapshots[2].jobsProcessed).toBe(3);
      });
    });
  });

  // ============ isHealthy() Tests ============

  describe('isHealthy()', () => {
    it('should return false when stopped', () => {
      expect(processor.isHealthy()).toBe(false);
    });

    it('should return true when running with low error rate', async () => {
      await processor.start();
      expect(processor.isHealthy()).toBe(true);
    });

    it('should return true when error rate is below threshold', async () => {
      await processor.start();

      const successHandler: JobHandler = {
        handle: async (): Promise<JobResult> => ({
          success: true,
          output: 'success',
        }),
      };
      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Failed');
        },
      };

      // 3 successes, 1 failure = 25% error rate
      processor.registerHandler('agent', successHandler);
      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({ type: 'agent' }));

      processor.registerHandler('agent', failHandler);
      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(processor.isHealthy()).toBe(true);
    });

    it('should return false when error rate exceeds threshold', async () => {
      await processor.start();

      const failHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          throw new Error('Failed');
        },
      };
      processor.registerHandler('agent', failHandler);

      // All jobs fail = 100% error rate
      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(processor.isHealthy()).toBe(false);
    });
  });

  // ============ Event Tests ============

  describe('events', () => {
    it('should support multiple listeners for same event', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      processor.on('started', listener1);
      processor.on('started', listener2);

      await processor.start();

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should remove listener with off()', async () => {
      const listener = vi.fn();

      processor.on('started', listener);
      processor.off('started', listener);

      await processor.start();

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support once() for single-use listeners', async () => {
      const listener = vi.fn();

      processor.once('started', listener);

      await processor.start();
      await processor.stop();
      await processor.start();

      expect(listener).toHaveBeenCalledTimes(1);

      await processor.stop();
    });

    describe('event types', () => {
      it('should emit started event', async () => {
        const handler = vi.fn();
        processor.on('started', handler);

        await processor.start();

        expect(handler).toHaveBeenCalledWith(config.workerId);
      });

      it('should emit stopped event', async () => {
        const handler = vi.fn();
        processor.on('stopped', handler);

        await processor.start();
        await processor.stop();

        expect(handler).toHaveBeenCalledWith(config.workerId);
      });

      it('should emit job:started event', async () => {
        const handler = vi.fn();
        processor.on('job:started', handler);

        await processor.start();
        const job = createTestJob();
        await processor.processJob(job);

        expect(handler).toHaveBeenCalledWith(job);
      });

      it('should emit job:completed event', async () => {
        const handler = vi.fn();
        processor.on('job:completed', handler);

        const successHandler: JobHandler = {
          handle: async (): Promise<JobResult> => ({
            success: true,
            output: 'done',
          }),
        };
        processor.registerHandler('agent', successHandler);

        await processor.start();
        const job = createTestJob({ type: 'agent' });
        await processor.processJob(job);

        expect(handler).toHaveBeenCalledWith(job, expect.objectContaining({
          success: true,
          output: 'done',
        }));
      });

      it('should emit job:failed event', async () => {
        const handler = vi.fn();
        processor.on('job:failed', handler);

        const failHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            throw new Error('Test failure');
          },
        };
        processor.registerHandler('agent', failHandler);

        await processor.start();
        const job = createTestJob({ type: 'agent' });
        await processor.processJob(job);

        expect(handler).toHaveBeenCalledWith(job, expect.any(Error));
        expect(handler.mock.calls[0][1].message).toBe('Test failure');
      });

      it('should emit job:retrying event', async () => {
        const handler = vi.fn();
        processor.on('job:retrying', handler);

        const failHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            throw new Error('Retryable error');
          },
        };
        processor.registerHandler('agent', failHandler);

        await processor.start();
        const job = createTestJob({
          type: 'agent',
          attempts: 0,
          maxAttempts: 3,
        });
        await processor.processJob(job);

        expect(handler).toHaveBeenCalledWith(
          job,
          expect.any(Number), // attempt
          expect.any(Number)  // delay
        );
      });

      it('should emit metrics:snapshot event', async () => {
        const handler = vi.fn();
        processor.on('metrics:snapshot', handler);

        await processor.start();
        await processor.processJob(createTestJob());

        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
          jobsProcessed: expect.any(Number),
          jobsSucceeded: expect.any(Number),
          jobsFailed: expect.any(Number),
          errorRate: expect.any(Number),
          avgProcessingTime: expect.any(Number),
        }));
      });

      it('should emit shutdown:initiated event', async () => {
        const handler = vi.fn();
        processor.on('shutdown:initiated', handler);

        await processor.start();
        await processor.stop();

        expect(handler).toHaveBeenCalledTimes(1);
      });

      it('should emit shutdown:timeout event', async () => {
        vi.useRealTimers();
        const handler = vi.fn();

        const timeoutConfig = createTestConfig({
          gracefulShutdownTimeout: 50,
          forceShutdownOnTimeout: true,
        });
        const timeoutProcessor = new WorkerProcessor(
          createMockScheduler(),
          createMockAgentRegistry(),
          createMockRouter(),
          timeoutConfig
        );

        const slowHandler: JobHandler = {
          handle: async (): Promise<JobResult> => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return { success: true, output: 'done' };
          },
        };
        timeoutProcessor.registerHandler('agent', slowHandler);
        timeoutProcessor.on('shutdown:timeout', handler);

        await timeoutProcessor.start();
        const job = createTestJob({ type: 'agent' });
        const processPromise = timeoutProcessor.processJob(job);

        await timeoutProcessor.stop();

        expect(handler).toHaveBeenCalledWith(job);

        await processPromise.catch(() => {});
      });
    });
  });

  // ============ Handler Registration Tests ============

  describe('handler registration', () => {
    it('should register a handler for a job type', async () => {
      const handler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'test' }),
      };

      processor.registerHandler('agent', handler);
      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(handler.handle).toHaveBeenCalled();
    });

    it('should replace existing handler for same type', async () => {
      const handler1: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'handler1' }),
      };
      const handler2: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'handler2' }),
      };

      processor.registerHandler('agent', handler1);
      processor.registerHandler('agent', handler2);
      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(handler1.handle).not.toHaveBeenCalled();
      expect(handler2.handle).toHaveBeenCalled();
    });

    it('should unregister a handler', async () => {
      const handler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'test' }),
      };

      processor.registerHandler('agent', handler);
      processor.unregisterHandler('agent');
      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(handler.handle).not.toHaveBeenCalled();
    });
  });
});
