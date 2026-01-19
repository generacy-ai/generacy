/**
 * Tests for the JobProcessor class.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobProcessor } from '../../src/scheduler/job-processor.js';
import { JobScheduler } from '../../src/scheduler/job-scheduler.js';
import { MemoryBackend } from '../../src/scheduler/backends/memory-backend.js';
import type { Job, JobCreateInput, JobProcessor as JobProcessorFn } from '../../src/scheduler/types.js';

function createTestInput(overrides: Partial<JobCreateInput> = {}): JobCreateInput {
  return {
    workflowId: 'workflow-1',
    stepId: 'step-1',
    type: 'agent',
    payload: { test: true },
    ...overrides,
  };
}

describe('JobProcessor', () => {
  let scheduler: JobScheduler;
  let processor: JobProcessor;
  let backend: MemoryBackend;
  let mockHandler: JobProcessorFn;

  beforeEach(async () => {
    backend = new MemoryBackend();
    scheduler = new JobScheduler({ backend });
    await scheduler.start();

    mockHandler = vi.fn().mockResolvedValue({ processed: true });
    processor = new JobProcessor(scheduler, mockHandler);
  });

  afterEach(async () => {
    processor.stop();
    await scheduler.stop();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create processor with scheduler and handler', () => {
      const p = new JobProcessor(scheduler, mockHandler);
      expect(p).toBeDefined();
    });

    it('should accept custom options', () => {
      const p = new JobProcessor(scheduler, mockHandler, {
        pollIntervalMs: 500,
        maxConcurrent: 5,
      });
      expect(p).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start processing', () => {
      processor.start();
      expect(processor.isRunning()).toBe(true);
    });

    it('should stop processing', () => {
      processor.start();
      processor.stop();
      expect(processor.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      processor.start();
      processor.start(); // Should be idempotent
      expect(processor.isRunning()).toBe(true);
    });
  });

  describe('process', () => {
    it('should process a job', async () => {
      await scheduler.enqueue(createTestInput());

      processor.start();

      // Wait for processing
      await vi.waitFor(
        async () => {
          expect(mockHandler).toHaveBeenCalled();
        },
        { timeout: 2000 }
      );
    });

    it('should call handler with job', async () => {
      const jobId = await scheduler.enqueue(createTestInput({ payload: { foo: 'bar' } }));

      processor.start();

      await vi.waitFor(
        async () => {
          expect(mockHandler).toHaveBeenCalledWith(
            expect.objectContaining({
              id: jobId,
              payload: { foo: 'bar' },
            })
          );
        },
        { timeout: 2000 }
      );
    });

    it('should acknowledge job on success', async () => {
      const jobId = await scheduler.enqueue(createTestInput());

      processor.start();

      await vi.waitFor(
        async () => {
          const job = await scheduler.getJob(jobId);
          expect(job?.status).toBe('completed');
        },
        { timeout: 2000 }
      );
    });

    it('should store result from handler', async () => {
      const result = { output: 'success' };
      mockHandler = vi.fn().mockResolvedValue(result);
      processor = new JobProcessor(scheduler, mockHandler);

      const jobId = await scheduler.enqueue(createTestInput());
      processor.start();

      await vi.waitFor(
        async () => {
          const job = await scheduler.getJob(jobId);
          expect(job?.result).toEqual(result);
        },
        { timeout: 2000 }
      );
    });
  });

  describe('error handling', () => {
    it('should nack job on handler error', async () => {
      mockHandler = vi.fn().mockRejectedValue(new Error('Handler error'));
      processor = new JobProcessor(scheduler, mockHandler);

      const jobId = await scheduler.enqueue(createTestInput({ maxAttempts: 3 }));
      processor.start();

      await vi.waitFor(
        async () => {
          const job = await scheduler.getJob(jobId);
          expect(job?.attempts).toBeGreaterThan(0);
          expect(job?.error).toBe('Handler error');
        },
        { timeout: 2000 }
      );
    });

    it('should retry failed job', async () => {
      let callCount = 0;
      mockHandler = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount < 2) {
          throw new Error('Temporary error');
        }
        return { success: true };
      });

      processor = new JobProcessor(scheduler, mockHandler, {
        pollIntervalMs: 50,
      });

      const jobId = await scheduler.enqueue(createTestInput({ maxAttempts: 3 }));
      processor.start();

      await vi.waitFor(
        async () => {
          const job = await scheduler.getJob(jobId);
          expect(job?.status).toBe('completed');
          expect(callCount).toBe(2);
        },
        { timeout: 5000 }
      );
    });

    it('should move job to dead letter after max attempts', async () => {
      mockHandler = vi.fn().mockRejectedValue(new Error('Permanent error'));
      processor = new JobProcessor(scheduler, mockHandler, {
        pollIntervalMs: 50,
      });

      const jobId = await scheduler.enqueue(createTestInput({ maxAttempts: 2 }));
      processor.start();

      await vi.waitFor(
        async () => {
          const job = await scheduler.getJob(jobId);
          expect(job?.status).toBe('dead');
        },
        { timeout: 5000 }
      );

      const dlq = await scheduler.getDeadLetterQueue();
      expect(dlq).toHaveLength(1);
    });
  });

  describe('concurrency', () => {
    it('should respect maxConcurrent limit', async () => {
      let concurrentCount = 0;
      let maxConcurrent = 0;

      mockHandler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise(r => setTimeout(r, 100));
        concurrentCount--;
        return { done: true };
      });

      processor = new JobProcessor(scheduler, mockHandler, {
        pollIntervalMs: 10,
        maxConcurrent: 2,
      });

      // Enqueue more jobs than maxConcurrent
      await scheduler.enqueue(createTestInput());
      await scheduler.enqueue(createTestInput());
      await scheduler.enqueue(createTestInput());
      await scheduler.enqueue(createTestInput());

      processor.start();

      await vi.waitFor(
        async () => {
          expect(mockHandler).toHaveBeenCalledTimes(4);
        },
        { timeout: 5000 }
      );

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('pause/resume', () => {
    it('should pause processing when scheduler is paused', async () => {
      await scheduler.enqueue(createTestInput());

      scheduler.pause();
      processor.start();

      await new Promise(r => setTimeout(r, 200));
      expect(mockHandler).not.toHaveBeenCalled();
    });

    it('should resume processing when scheduler is resumed', async () => {
      await scheduler.enqueue(createTestInput());

      scheduler.pause();
      processor.start();

      await new Promise(r => setTimeout(r, 100));
      scheduler.resume();

      await vi.waitFor(
        async () => {
          expect(mockHandler).toHaveBeenCalled();
        },
        { timeout: 2000 }
      );
    });
  });

  describe('events', () => {
    it('should emit job:completed event on success', async () => {
      const listener = vi.fn();
      scheduler.on('job:completed', listener);

      await scheduler.enqueue(createTestInput());
      processor.start();

      await vi.waitFor(
        async () => {
          expect(listener).toHaveBeenCalled();
        },
        { timeout: 2000 }
      );
    });

    it('should emit job:failed event on error', async () => {
      mockHandler = vi.fn().mockRejectedValue(new Error('Test error'));
      processor = new JobProcessor(scheduler, mockHandler);

      const listener = vi.fn();
      scheduler.on('job:failed', listener);

      await scheduler.enqueue(createTestInput({ maxAttempts: 3 }));
      processor.start();

      await vi.waitFor(
        async () => {
          expect(listener).toHaveBeenCalled();
        },
        { timeout: 2000 }
      );
    });

    it('should emit job:dead event when job exhausts retries', async () => {
      mockHandler = vi.fn().mockRejectedValue(new Error('Fatal error'));
      processor = new JobProcessor(scheduler, mockHandler, {
        pollIntervalMs: 50,
      });

      const listener = vi.fn();
      scheduler.on('job:dead', listener);

      await scheduler.enqueue(createTestInput({ maxAttempts: 1 }));
      processor.start();

      await vi.waitFor(
        async () => {
          expect(listener).toHaveBeenCalled();
        },
        { timeout: 2000 }
      );
    });
  });

  describe('visibility timeout handling', () => {
    it('should release timed out jobs', async () => {
      // Create a handler that takes longer than visibility timeout
      mockHandler = vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 500));
        return { done: true };
      });

      processor = new JobProcessor(scheduler, mockHandler, {
        visibilityCheckIntervalMs: 50,
      });

      // Create job with short visibility timeout
      const jobId = await scheduler.enqueue(
        createTestInput({ visibilityTimeout: 100 })
      );

      // Manually dequeue to simulate processing
      await scheduler.dequeue();

      // Wait for visibility timeout to expire
      await new Promise(r => setTimeout(r, 200));

      // Release timed out jobs
      const released = await scheduler.releaseTimedOutJobs();
      expect(released).toBe(1);

      const job = await scheduler.getJob(jobId);
      expect(job?.status).toBe('pending');
    });
  });
});
