/**
 * Integration test: Full job processing flow.
 *
 * Tests the complete job processing lifecycle from enqueue to completion,
 * verifying that all components work together correctly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Job, JobType } from '../../../src/scheduler/types.js';
import type {
  WorkerConfig,
  JobHandler,
  JobResult,
  AgentJobPayload,
  HumanJobPayload,
  IntegrationJobPayload,
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
    workerId: 'integration-test-worker',
    health: { enabled: false, port: 3001 },
    heartbeat: { enabled: false, interval: 5000, ttl: 15000 },
    ...overrides,
  };
}

function createTestJob(overrides: Partial<Job> = {}): Job {
  return {
    id: `job_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    workflowId: 'workflow-test',
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

describe('Integration: Job Processing Flow', () => {
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

  describe('complete job lifecycle', () => {
    it('should process agent job from start to completion', async () => {
      const events: string[] = [];
      processor.on('job:started', () => events.push('started'));
      processor.on('job:completed', () => events.push('completed'));

      const agentHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({
          success: true,
          output: 'Agent task completed',
        }),
      };
      processor.registerHandler('agent', agentHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const result = await processor.processJob(job);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Agent task completed');
      expect(result.duration).toBeDefined();
      expect(events).toEqual(['started', 'completed']);
      expect(scheduler.acknowledge).toHaveBeenCalledWith(job.id, expect.any(Object));
    });

    it('should process human job from start to completion', async () => {
      const humanHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({
          success: true,
          output: { approved: true, respondedBy: 'user@test.com' },
        }),
      };
      processor.registerHandler('human', humanHandler);

      await processor.start();

      const job = createTestJob({
        type: 'human',
        payload: {
          type: 'approval',
          title: 'Test Approval',
          description: 'Please approve',
          urgency: 'normal',
          timeout: 60000,
        } as HumanJobPayload,
      });

      const result = await processor.processJob(job);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ approved: true, respondedBy: 'user@test.com' });
    });

    it('should process integration job from start to completion', async () => {
      const integrationHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({
          success: true,
          output: { status: 'created', id: 'resource-123' },
          statusCode: 201,
        }),
      };
      processor.registerHandler('integration', integrationHandler);

      await processor.start();

      const job = createTestJob({
        type: 'integration',
        payload: {
          integration: 'github',
          action: 'createIssue',
          params: { title: 'Test Issue' },
        } as IntegrationJobPayload,
      });

      const result = await processor.processJob(job);

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ status: 'created', id: 'resource-123' });
    });
  });

  describe('job failure handling', () => {
    it('should handle job failure and nack', async () => {
      const events: string[] = [];
      processor.on('job:started', () => events.push('started'));
      processor.on('job:failed', () => events.push('failed'));

      const failHandler: JobHandler = {
        handle: vi.fn().mockRejectedValue(new Error('Handler error')),
      };
      processor.registerHandler('agent', failHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      const result = await processor.processJob(job);

      expect(result.success).toBe(false);
      expect(events).toEqual(['started', 'failed']);
      expect(scheduler.nack).toHaveBeenCalledWith(job.id, expect.any(Error));
    });

    it('should emit retrying event when attempts remain', async () => {
      const events: string[] = [];
      processor.on('job:retrying', () => events.push('retrying'));

      const failHandler: JobHandler = {
        handle: vi.fn().mockRejectedValue(new Error('Transient error')),
      };
      processor.registerHandler('agent', failHandler);

      await processor.start();

      const job = createTestJob({
        type: 'agent',
        attempts: 0,
        maxAttempts: 3,
      });
      await processor.processJob(job);

      expect(events).toContain('retrying');
    });

    it('should not emit retrying event when max attempts reached', async () => {
      const events: string[] = [];
      processor.on('job:retrying', () => events.push('retrying'));

      const failHandler: JobHandler = {
        handle: vi.fn().mockRejectedValue(new Error('Final error')),
      };
      processor.registerHandler('agent', failHandler);

      await processor.start();

      const job = createTestJob({
        type: 'agent',
        attempts: 2,
        maxAttempts: 3,
      });
      await processor.processJob(job);

      expect(events).not.toContain('retrying');
    });
  });

  describe('metrics tracking', () => {
    it('should track successful job metrics', async () => {
      const successHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
      };
      processor.registerHandler('agent', successHandler);

      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({ type: 'agent' }));

      const metrics = processor.getMetrics();

      expect(metrics.jobsProcessed).toBe(2);
      expect(metrics.jobsSucceeded).toBe(2);
      expect(metrics.jobsFailed).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });

    it('should track failed job metrics', async () => {
      const failHandler: JobHandler = {
        handle: vi.fn().mockRejectedValue(new Error('Error')),
      };
      processor.registerHandler('agent', failHandler);

      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({ type: 'agent' }));

      const metrics = processor.getMetrics();

      expect(metrics.jobsProcessed).toBe(2);
      expect(metrics.jobsFailed).toBe(2);
      expect(metrics.errorRate).toBe(1);
    });

    it('should emit metrics:snapshot after each job', async () => {
      const snapshots: unknown[] = [];
      processor.on('metrics:snapshot', (m) => snapshots.push(m));

      const handler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'done' }),
      };
      processor.registerHandler('agent', handler);

      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(snapshots.length).toBeGreaterThan(0);
    });
  });

  describe('handler registration', () => {
    it('should use registered handler for job type', async () => {
      const customHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'custom' }),
      };
      processor.registerHandler('agent', customHandler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(customHandler.handle).toHaveBeenCalledWith(job);
    });

    it('should allow handler replacement', async () => {
      const handler1: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'first' }),
      };
      const handler2: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'second' }),
      };

      processor.registerHandler('agent', handler1);
      processor.registerHandler('agent', handler2);

      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(handler1.handle).not.toHaveBeenCalled();
      expect(handler2.handle).toHaveBeenCalled();
    });

    it('should handle multiple job types with different handlers', async () => {
      const agentHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'agent' }),
      };
      const humanHandler: JobHandler = {
        handle: vi.fn().mockResolvedValue({ success: true, output: 'human' }),
      };

      processor.registerHandler('agent', agentHandler);
      processor.registerHandler('human', humanHandler);

      await processor.start();

      await processor.processJob(createTestJob({ type: 'agent' }));
      await processor.processJob(createTestJob({
        type: 'human',
        payload: {
          type: 'approval',
          title: 'Test',
          description: 'Test',
          urgency: 'normal',
          timeout: 60000,
        } as HumanJobPayload,
      }));

      expect(agentHandler.handle).toHaveBeenCalledTimes(1);
      expect(humanHandler.handle).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrent operations', () => {
    it('should track status correctly during processing', async () => {
      let statusDuringProcessing: string | undefined;

      const slowHandler: JobHandler = {
        handle: async () => {
          statusDuringProcessing = processor.getStatus();
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', slowHandler);

      await processor.start();
      expect(processor.getStatus()).toBe('idle');

      await processor.processJob(createTestJob({ type: 'agent' }));

      expect(statusDuringProcessing).toBe('processing');
      expect(processor.getStatus()).toBe('idle');
    });

    it('should track current job during processing', async () => {
      let currentJobDuringProcessing: Job | undefined;

      const handler: JobHandler = {
        handle: async () => {
          currentJobDuringProcessing = processor.getCurrentJob();
          return { success: true, output: 'done' };
        },
      };
      processor.registerHandler('agent', handler);

      await processor.start();

      const job = createTestJob({ type: 'agent' });
      await processor.processJob(job);

      expect(currentJobDuringProcessing?.id).toBe(job.id);
      expect(processor.getCurrentJob()).toBeUndefined();
    });
  });
});
