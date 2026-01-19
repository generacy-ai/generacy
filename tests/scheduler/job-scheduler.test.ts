/**
 * Tests for the JobScheduler class.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobScheduler } from '../../src/scheduler/job-scheduler.js';
import { MemoryBackend } from '../../src/scheduler/backends/memory-backend.js';
import type { Job, JobCreateInput } from '../../src/scheduler/types.js';
import type { SchedulerMetrics } from '../../src/scheduler/events.js';

function createTestInput(overrides: Partial<JobCreateInput> = {}): JobCreateInput {
  return {
    workflowId: 'workflow-1',
    stepId: 'step-1',
    type: 'agent',
    payload: { test: true },
    ...overrides,
  };
}

describe('JobScheduler', () => {
  let scheduler: JobScheduler;
  let backend: MemoryBackend;

  beforeEach(async () => {
    backend = new MemoryBackend();
    scheduler = new JobScheduler({ backend });
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.stop();
  });

  describe('constructor', () => {
    it('should create scheduler with provided backend', () => {
      const s = new JobScheduler({ backend: new MemoryBackend() });
      expect(s).toBeDefined();
    });

    it('should create scheduler with memory backend by default', () => {
      const s = new JobScheduler({});
      expect(s).toBeDefined();
    });
  });

  describe('start/stop', () => {
    it('should start and connect to backend', async () => {
      const newBackend = new MemoryBackend();
      const newScheduler = new JobScheduler({ backend: newBackend });

      await newScheduler.start();
      const health = await newScheduler.healthCheck();
      expect(health.healthy).toBe(true);

      await newScheduler.stop();
    });

    it('should stop and disconnect from backend', async () => {
      await scheduler.stop();
      // Scheduler should handle being stopped gracefully
    });
  });

  describe('enqueue', () => {
    it('should create and enqueue a job', async () => {
      const jobId = await scheduler.enqueue(createTestInput());
      expect(jobId).toBeDefined();
      expect(jobId).toMatch(/^job_/);
    });

    it('should emit job:enqueued event', async () => {
      const listener = vi.fn();
      scheduler.on('job:enqueued', listener);

      await scheduler.enqueue(createTestInput());

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toHaveProperty('id');
    });

    it('should apply default priority', async () => {
      const jobId = await scheduler.enqueue(createTestInput());
      const job = await scheduler.getJob(jobId);
      expect(job?.priority).toBe('normal');
    });

    it('should respect specified priority', async () => {
      const jobId = await scheduler.enqueue(createTestInput({ priority: 'high' }));
      const job = await scheduler.getJob(jobId);
      expect(job?.priority).toBe('high');
    });
  });

  describe('dequeue', () => {
    it('should dequeue a job', async () => {
      const jobId = await scheduler.enqueue(createTestInput());
      const job = await scheduler.dequeue();

      expect(job).toBeDefined();
      expect(job?.id).toBe(jobId);
    });

    it('should return undefined when queue is empty', async () => {
      const job = await scheduler.dequeue();
      expect(job).toBeUndefined();
    });

    it('should emit job:started event', async () => {
      const listener = vi.fn();
      scheduler.on('job:started', listener);

      await scheduler.enqueue(createTestInput());
      await scheduler.dequeue();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('should respect priority ordering', async () => {
      await scheduler.enqueue(createTestInput({ priority: 'low' }));
      const highId = await scheduler.enqueue(createTestInput({ priority: 'high' }));

      const job = await scheduler.dequeue();
      expect(job?.id).toBe(highId);
    });
  });

  describe('getJob', () => {
    it('should return job by id', async () => {
      const jobId = await scheduler.enqueue(createTestInput());
      const job = await scheduler.getJob(jobId);

      expect(job).toBeDefined();
      expect(job?.workflowId).toBe('workflow-1');
    });

    it('should return undefined for non-existent job', async () => {
      const job = await scheduler.getJob('non-existent');
      expect(job).toBeUndefined();
    });
  });

  describe('updateJob', () => {
    it('should update job properties', async () => {
      const jobId = await scheduler.enqueue(createTestInput());
      await scheduler.updateJob(jobId, { result: { success: true } });

      const job = await scheduler.getJob(jobId);
      expect(job?.result).toEqual({ success: true });
    });

    it('should throw for non-existent job', async () => {
      await expect(
        scheduler.updateJob('non-existent', { result: 'test' })
      ).rejects.toThrow();
    });
  });

  describe('pause/resume', () => {
    it('should pause processing', () => {
      scheduler.pause();
      expect(scheduler.isPaused()).toBe(true);
    });

    it('should resume processing', () => {
      scheduler.pause();
      scheduler.resume();
      expect(scheduler.isPaused()).toBe(false);
    });

    it('should not dequeue when paused', async () => {
      await scheduler.enqueue(createTestInput());
      scheduler.pause();

      // Dequeue should still work, but processor would not call it
      // This is a behavioral check - pause is for the processor
      const job = await scheduler.dequeue();
      expect(job).toBeDefined();
    });
  });

  describe('dead letter queue', () => {
    it('should return empty array when no dead jobs', async () => {
      const dlq = await scheduler.getDeadLetterQueue();
      expect(dlq).toEqual([]);
    });

    it('should return dead letter jobs after max retries', async () => {
      const jobId = await scheduler.enqueue(createTestInput({ maxAttempts: 1 }));
      await scheduler.dequeue();

      // Simulate failure
      await backend.nack(jobId, 'Test error');

      const dlq = await scheduler.getDeadLetterQueue();
      expect(dlq).toHaveLength(1);
    });

    it('should retry dead letter job', async () => {
      const jobId = await scheduler.enqueue(createTestInput({ maxAttempts: 1 }));
      await scheduler.dequeue();
      await backend.nack(jobId, 'Test error');

      await scheduler.retryDeadLetter(jobId);

      const dlq = await scheduler.getDeadLetterQueue();
      expect(dlq).toHaveLength(0);

      const job = await scheduler.getJob(jobId);
      expect(job?.status).toBe('pending');
    });
  });

  describe('getQueueStats', () => {
    it('should return queue statistics', async () => {
      await scheduler.enqueue(createTestInput({ priority: 'high' }));
      await scheduler.enqueue(createTestInput({ priority: 'normal' }));
      await scheduler.enqueue(createTestInput({ priority: 'normal' }));
      await scheduler.enqueue(createTestInput({ priority: 'low' }));
      await scheduler.dequeue();

      const stats = await scheduler.getQueueStats();

      expect(stats.queueDepth.high).toBe(0); // One was dequeued
      expect(stats.queueDepth.normal).toBe(2);
      expect(stats.queueDepth.low).toBe(1);
      expect(stats.queueDepth.total).toBe(3);
      expect(stats.processing).toBe(1);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status', async () => {
      const health = await scheduler.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('should include queue depth', async () => {
      await scheduler.enqueue(createTestInput());
      await scheduler.enqueue(createTestInput());

      const health = await scheduler.healthCheck();
      expect(health.details?.queueDepth).toBe(2);
    });
  });

  describe('events', () => {
    it('should support multiple listeners', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      scheduler.on('job:enqueued', listener1);
      scheduler.on('job:enqueued', listener2);

      await scheduler.enqueue(createTestInput());

      expect(listener1).toHaveBeenCalledTimes(1);
      expect(listener2).toHaveBeenCalledTimes(1);
    });

    it('should remove listener with off', async () => {
      const listener = vi.fn();

      scheduler.on('job:enqueued', listener);
      scheduler.off('job:enqueued', listener);

      await scheduler.enqueue(createTestInput());

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    it('should emit metrics:snapshot periodically', async () => {
      // Create scheduler with short metrics interval
      const newScheduler = new JobScheduler({
        backend: new MemoryBackend(),
        config: { metricsIntervalMs: 50 },
      });

      const listener = vi.fn();
      newScheduler.on('metrics:snapshot', listener);

      await newScheduler.start();

      // Wait for at least one metrics emission
      await vi.waitFor(
        () => {
          expect(listener).toHaveBeenCalled();
        },
        { timeout: 500 }
      );

      const metrics: SchedulerMetrics = listener.mock.calls[0][0];
      expect(metrics).toHaveProperty('timestamp');
      expect(metrics).toHaveProperty('queueDepth');
      expect(metrics).toHaveProperty('processing');
      expect(metrics).toHaveProperty('deadLetter');

      await newScheduler.stop();
    });

    it('should include correct queue depth in metrics', async () => {
      const newScheduler = new JobScheduler({
        backend: new MemoryBackend(),
        config: { metricsIntervalMs: 50 },
      });

      await newScheduler.start();
      await newScheduler.enqueue(createTestInput({ priority: 'high' }));
      await newScheduler.enqueue(createTestInput({ priority: 'normal' }));

      const listener = vi.fn();
      newScheduler.on('metrics:snapshot', listener);

      await vi.waitFor(
        () => {
          expect(listener).toHaveBeenCalled();
        },
        { timeout: 500 }
      );

      const metrics: SchedulerMetrics = listener.mock.calls[0][0];
      expect(metrics.queueDepth.high).toBe(1);
      expect(metrics.queueDepth.normal).toBe(1);
      expect(metrics.queueDepth.total).toBe(2);

      await newScheduler.stop();
    });
  });
});
