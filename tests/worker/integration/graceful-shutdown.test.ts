/**
 * Integration test: Graceful shutdown.
 *
 * Tests the graceful shutdown behavior, ensuring jobs in progress
 * are allowed to complete before the worker stops.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Job } from '../../../src/scheduler/types.js';
import type {
  WorkerConfig,
  JobHandler,
  JobResult,
  AgentJobPayload,
} from '../../../src/worker/types.js';
import { DEFAULT_WORKER_CONFIG } from '../../../src/worker/config/worker-config.js';
import { WorkerProcessor } from '../../../src/worker/worker-processor.js';

// ============ Mock Dependencies ============

interface MockScheduler {
  dequeue: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  nack: ReturnType<typeof vi.fn>;
}

interface MockAgentRegistry {
  get: ReturnType<typeof vi.fn>;
}

interface MockRouter {
  routeAndWait: ReturnType<typeof vi.fn>;
}

function createMockScheduler(): MockScheduler {
  return {
    dequeue: vi.fn().mockResolvedValue(undefined),
    acknowledge: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockAgentRegistry(): MockAgentRegistry {
  return {
    get: vi.fn().mockReturnValue(undefined),
  };
}

function createMockRouter(): MockRouter {
  return {
    routeAndWait: vi.fn().mockResolvedValue(undefined),
  };
}

function createTestConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...DEFAULT_WORKER_CONFIG,
    workerId: 'graceful-shutdown-test-worker',
    health: { enabled: false, port: 3001 },
    heartbeat: { enabled: false, interval: 5000, ttl: 15000 },
    gracefulShutdownTimeout: 5000,
    forceShutdownOnTimeout: true,
    ...overrides,
  };
}

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    workflowId: 'workflow-shutdown-test',
    stepId: 'step-1',
    type: 'agent',
    status: 'pending',
    priority: 'normal',
    attempts: 0,
    maxAttempts: 3,
    payload: { command: 'test command' } as AgentJobPayload,
    createdAt: new Date().toISOString(),
    visibilityTimeout: 30000,
    ...overrides,
  };
}

describe('Integration: Graceful Shutdown', () => {
  let processor: WorkerProcessor;
  let scheduler: MockScheduler;
  let agentRegistry: MockAgentRegistry;
  let router: MockRouter;
  let config: WorkerConfig;

  beforeEach(() => {
    scheduler = createMockScheduler();
    agentRegistry = createMockAgentRegistry();
    router = createMockRouter();
    config = createTestConfig();
    processor = new WorkerProcessor(scheduler, agentRegistry, router, config);
  });

  afterEach(async () => {
    if (processor.getStatus() !== 'stopped') {
      await processor.stop();
    }
    vi.clearAllMocks();
  });

  describe('shutdown without active job', () => {
    it('should stop immediately when no job is processing', async () => {
      await processor.start();
      expect(processor.getStatus()).toBe('idle');

      const stopStart = Date.now();
      await processor.stop();
      const stopDuration = Date.now() - stopStart;

      expect(processor.getStatus()).toBe('stopped');
      expect(stopDuration).toBeLessThan(100); // Should be nearly instant
    });

    it('should emit correct events during clean shutdown', async () => {
      const events: string[] = [];
      processor.on('started', () => events.push('started'));
      processor.on('shutdown:initiated', () => events.push('shutdown:initiated'));
      processor.on('stopped', () => events.push('stopped'));

      await processor.start();
      await processor.stop();

      expect(events).toEqual(['started', 'shutdown:initiated', 'stopped']);
    });
  });

  describe('shutdown with active job', () => {
    it('should wait for job to complete before stopping', async () => {
      let jobCompleted = false;

      const slowHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          jobCompleted = true;
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', slowHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      // Start stop immediately after job begins
      await new Promise((resolve) => setTimeout(resolve, 10));
      const stopPromise = processor.stop();

      // Both should complete
      await Promise.all([processPromise, stopPromise]);

      expect(jobCompleted).toBe(true);
      expect(processor.getStatus()).toBe('stopped');
      expect(scheduler.acknowledge).toHaveBeenCalled();
    });

    it('should transition through draining status', async () => {
      const statusHistory: string[] = [];

      const slowHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', slowHandler);

      await processor.start();
      statusHistory.push(processor.getStatus());

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      // Wait for job to start
      await new Promise((resolve) => setTimeout(resolve, 10));
      statusHistory.push(processor.getStatus());

      // Start stop
      const stopPromise = processor.stop();

      // Check status during drain
      await new Promise((resolve) => setTimeout(resolve, 10));
      statusHistory.push(processor.getStatus());

      await Promise.all([processPromise, stopPromise]);
      statusHistory.push(processor.getStatus());

      expect(statusHistory).toContain('idle');
      expect(statusHistory).toContain('processing');
      expect(statusHistory).toContain('draining');
      expect(statusHistory[statusHistory.length - 1]).toBe('stopped');
    });
  });

  describe('shutdown timeout', () => {
    it('should emit timeout event when job takes too long', async () => {
      const shortTimeoutConfig = createTestConfig({
        gracefulShutdownTimeout: 50,
        forceShutdownOnTimeout: true,
      });
      processor = new WorkerProcessor(scheduler, agentRegistry, router, shortTimeoutConfig);

      let timeoutEmitted = false;
      processor.on('shutdown:timeout', () => {
        timeoutEmitted = true;
      });

      const verySlowHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', verySlowHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      // Wait for job to start
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Stop should timeout
      await processor.stop();

      expect(timeoutEmitted).toBe(true);

      // Clean up
      await processPromise.catch(() => {});
    });

    it('should force exit when forceShutdownOnTimeout is true', async () => {
      const shortTimeoutConfig = createTestConfig({
        gracefulShutdownTimeout: 50,
        forceShutdownOnTimeout: true,
      });
      processor = new WorkerProcessor(scheduler, agentRegistry, router, shortTimeoutConfig);

      const verySlowHandler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', verySlowHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const stopStart = Date.now();
      await processor.stop();
      const stopDuration = Date.now() - stopStart;

      // Should have stopped relatively quickly due to force exit
      expect(stopDuration).toBeLessThan(200);
      expect(processor.getStatus()).toBe('stopped');

      // Clean up
      await processPromise.catch(() => {});
    });
  });

  describe('shutdown events', () => {
    it('should emit shutdown:initiated before waiting for job', async () => {
      const eventOrder: string[] = [];

      const handler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          eventOrder.push('job:processing');
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', handler);

      processor.on('shutdown:initiated', () => eventOrder.push('shutdown:initiated'));
      processor.on('stopped', () => eventOrder.push('stopped'));

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await processor.stop();
      await processPromise;

      expect(eventOrder.indexOf('shutdown:initiated')).toBeLessThan(
        eventOrder.indexOf('stopped')
      );
    });

    it('should emit stopped only after job completes', async () => {
      let jobCompleted = false;
      let stoppedWithJobComplete = false;

      const handler: JobHandler = {
        handle: async (): Promise<JobResult> => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          jobCompleted = true;
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', handler);

      processor.on('stopped', () => {
        stoppedWithJobComplete = jobCompleted;
      });

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const processPromise = processor.processJob(job);

      await new Promise((resolve) => setTimeout(resolve, 10));
      await processor.stop();
      await processPromise;

      expect(stoppedWithJobComplete).toBe(true);
    });
  });

  describe('multiple stop calls', () => {
    it('should handle multiple concurrent stop calls', async () => {
      await processor.start();

      // Multiple concurrent stops
      await Promise.all([
        processor.stop(),
        processor.stop(),
        processor.stop(),
      ]);

      expect(processor.getStatus()).toBe('stopped');
    });

    it('should handle stop when already stopped', async () => {
      await processor.start();
      await processor.stop();

      // Should not throw
      await processor.stop();

      expect(processor.getStatus()).toBe('stopped');
    });
  });

  describe('health during shutdown', () => {
    it('should report unhealthy after shutdown', async () => {
      await processor.start();
      expect(processor.isHealthy()).toBe(true);

      await processor.stop();
      expect(processor.isHealthy()).toBe(false);
    });

    it('should stop heartbeat during shutdown', async () => {
      const heartbeatConfig = createTestConfig({
        heartbeat: { enabled: true, interval: 1000, ttl: 5000 },
      });
      processor = new WorkerProcessor(scheduler, agentRegistry, router, heartbeatConfig);

      await processor.start();
      expect(processor.isHeartbeatRunning()).toBe(true);

      await processor.stop();
      expect(processor.isHeartbeatRunning()).toBe(false);
    });
  });
});
