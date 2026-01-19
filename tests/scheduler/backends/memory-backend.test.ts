/**
 * Tests for the in-memory queue backend.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryBackend } from '../../../src/scheduler/backends/memory-backend.js';
import type { Job } from '../../../src/scheduler/types.js';
import { createJob } from '../../../src/scheduler/types.js';

function createTestJob(overrides: Partial<Job> = {}): Job {
  return createJob({
    workflowId: 'workflow-1',
    stepId: 'step-1',
    type: 'agent',
    payload: { test: true },
    ...overrides,
  });
}

describe('MemoryBackend', () => {
  let backend: MemoryBackend;

  beforeEach(async () => {
    backend = new MemoryBackend();
    await backend.connect();
  });

  afterEach(async () => {
    await backend.disconnect();
  });

  describe('connect/disconnect', () => {
    it('should connect successfully', async () => {
      const newBackend = new MemoryBackend();
      await expect(newBackend.connect()).resolves.toBeUndefined();
      await newBackend.disconnect();
    });

    it('should disconnect successfully', async () => {
      await expect(backend.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('enqueue', () => {
    it('should enqueue a job', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(job.id);
    });

    it('should store job with all properties', async () => {
      const job = createTestJob({ priority: 'high' });
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved?.workflowId).toBe(job.workflowId);
      expect(retrieved?.stepId).toBe(job.stepId);
      expect(retrieved?.type).toBe(job.type);
      expect(retrieved?.priority).toBe('high');
      expect(retrieved?.payload).toEqual(job.payload);
    });
  });

  describe('dequeue', () => {
    it('should return undefined when queue is empty', async () => {
      const job = await backend.dequeue();
      expect(job).toBeUndefined();
    });

    it('should dequeue a job and set visibility timeout', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const dequeued = await backend.dequeue();
      expect(dequeued).toBeDefined();
      expect(dequeued?.id).toBe(job.id);
      expect(dequeued?.status).toBe('processing');
      expect(dequeued?.visibleAt).toBeDefined();
    });

    it('should return jobs in FIFO order within same priority', async () => {
      const job1 = createTestJob();
      const job2 = createTestJob();

      await backend.enqueue(job1);
      await backend.enqueue(job2);

      const first = await backend.dequeue();
      const second = await backend.dequeue();

      expect(first?.id).toBe(job1.id);
      expect(second?.id).toBe(job2.id);
    });

    it('should filter by priority when specified', async () => {
      const highJob = { ...createTestJob(), priority: 'high' as const };
      const normalJob = { ...createTestJob(), priority: 'normal' as const };

      await backend.enqueue(normalJob);
      await backend.enqueue(highJob);

      const dequeued = await backend.dequeue('normal');
      expect(dequeued?.id).toBe(normalJob.id);
    });
  });

  describe('priority ordering', () => {
    it('should dequeue high priority jobs before normal', async () => {
      const normalJob = { ...createTestJob(), priority: 'normal' as const };
      const highJob = { ...createTestJob(), priority: 'high' as const };

      // Enqueue normal first, then high
      await backend.enqueue(normalJob);
      await backend.enqueue(highJob);

      const first = await backend.dequeue();
      expect(first?.priority).toBe('high');
    });

    it('should dequeue normal priority jobs before low', async () => {
      const lowJob = { ...createTestJob(), priority: 'low' as const };
      const normalJob = { ...createTestJob(), priority: 'normal' as const };

      await backend.enqueue(lowJob);
      await backend.enqueue(normalJob);

      const first = await backend.dequeue();
      expect(first?.priority).toBe('normal');
    });

    it('should maintain FIFO within same priority level', async () => {
      const high1 = { ...createTestJob(), priority: 'high' as const };
      const high2 = { ...createTestJob(), priority: 'high' as const };
      const high3 = { ...createTestJob(), priority: 'high' as const };

      await backend.enqueue(high1);
      await backend.enqueue(high2);
      await backend.enqueue(high3);

      const first = await backend.dequeue();
      const second = await backend.dequeue();
      const third = await backend.dequeue();

      expect(first?.id).toBe(high1.id);
      expect(second?.id).toBe(high2.id);
      expect(third?.id).toBe(high3.id);
    });
  });

  describe('acknowledge', () => {
    it('should remove job from processing set', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      const processingBefore = await backend.getProcessingCount();
      expect(processingBefore).toBe(1);

      await backend.acknowledge(job.id);

      const processingAfter = await backend.getProcessingCount();
      expect(processingAfter).toBe(0);
    });

    it('should update job status to completed', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();
      await backend.acknowledge(job.id);

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.completedAt).toBeDefined();
    });
  });

  describe('nack', () => {
    it('should increment attempts count', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      await backend.nack(job.id, 'Test error');

      const updated = await backend.getJob(job.id);
      expect(updated?.attempts).toBe(1);
      expect(updated?.error).toBe('Test error');
    });

    it('should re-queue job if under max attempts', async () => {
      const job = { ...createTestJob(), maxAttempts: 3 };
      await backend.enqueue(job);
      await backend.dequeue();

      await backend.nack(job.id, 'Test error');

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('pending');

      const dequeued = await backend.dequeue();
      expect(dequeued?.id).toBe(job.id);
    });

    it('should move to dead letter if max attempts reached', async () => {
      const job = { ...createTestJob(), maxAttempts: 1 };
      await backend.enqueue(job);
      await backend.dequeue();

      await backend.nack(job.id, 'Final error');

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('dead');

      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toHaveLength(1);
      expect(dlq[0].id).toBe(job.id);
    });
  });

  describe('getJob', () => {
    it('should return undefined for non-existent job', async () => {
      const job = await backend.getJob('non-existent');
      expect(job).toBeUndefined();
    });

    it('should return job by id', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved?.id).toBe(job.id);
    });
  });

  describe('updateJob', () => {
    it('should update job properties', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      await backend.updateJob(job.id, { result: { success: true } });

      const updated = await backend.getJob(job.id);
      expect(updated?.result).toEqual({ success: true });
    });

    it('should throw for non-existent job', async () => {
      await expect(
        backend.updateJob('non-existent', { result: 'test' })
      ).rejects.toThrow('Job not found');
    });
  });

  describe('getQueueDepth', () => {
    it('should return 0 for empty queue', async () => {
      const depth = await backend.getQueueDepth();
      expect(depth).toBe(0);
    });

    it('should return total queue depth', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());

      const depth = await backend.getQueueDepth();
      expect(depth).toBe(2);
    });

    it('should return depth for specific priority', async () => {
      await backend.enqueue({ ...createTestJob(), priority: 'high' });
      await backend.enqueue({ ...createTestJob(), priority: 'normal' });
      await backend.enqueue({ ...createTestJob(), priority: 'normal' });

      const highDepth = await backend.getQueueDepth('high');
      const normalDepth = await backend.getQueueDepth('normal');

      expect(highDepth).toBe(1);
      expect(normalDepth).toBe(2);
    });

    it('should not count processing jobs', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());
      await backend.dequeue();

      const depth = await backend.getQueueDepth();
      expect(depth).toBe(1);
    });
  });

  describe('getProcessingCount', () => {
    it('should return 0 when no jobs processing', async () => {
      const count = await backend.getProcessingCount();
      expect(count).toBe(0);
    });

    it('should return count of processing jobs', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());
      await backend.dequeue();

      const count = await backend.getProcessingCount();
      expect(count).toBe(1);
    });
  });

  describe('dead letter operations', () => {
    it('should return empty array when no dead jobs', async () => {
      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toEqual([]);
    });

    it('should return dead letter jobs', async () => {
      const job = { ...createTestJob(), maxAttempts: 1 };
      await backend.enqueue(job);
      await backend.dequeue();
      await backend.nack(job.id, 'Fatal error');

      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toHaveLength(1);
      expect(dlq[0].status).toBe('dead');
    });

    it('should retry dead letter job', async () => {
      const job = { ...createTestJob(), maxAttempts: 1 };
      await backend.enqueue(job);
      await backend.dequeue();
      await backend.nack(job.id, 'Fatal error');

      await backend.retryDeadLetter(job.id);

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('pending');
      expect(updated?.attempts).toBe(0);
      expect(updated?.error).toBeUndefined();

      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toHaveLength(0);
    });

    it('should throw when retrying non-dead job', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      await expect(backend.retryDeadLetter(job.id)).rejects.toThrow('not in dead letter queue');
    });
  });

  describe('visibility timeout', () => {
    it('should set visibleAt on dequeue', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const dequeued = await backend.dequeue();
      expect(dequeued?.visibleAt).toBeDefined();
      expect(dequeued?.visibleAt).toBeGreaterThan(Date.now());
    });

    it('should refresh visibility timeout', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      const before = (await backend.getJob(job.id))?.visibleAt;
      await backend.refreshVisibility(job.id, 60000);
      const after = (await backend.getJob(job.id))?.visibleAt;

      expect(after).toBeGreaterThan(before!);
    });

    it('should release timed out jobs', async () => {
      vi.useFakeTimers();

      const job = { ...createTestJob(), visibilityTimeout: 1000 };
      await backend.enqueue(job);
      await backend.dequeue();

      // Advance time past visibility timeout
      vi.advanceTimersByTime(2000);

      const released = await backend.releaseTimedOutJobs();
      expect(released).toBe(1);

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('pending');

      vi.useRealTimers();
    });

    it('should not release jobs within visibility timeout', async () => {
      const job = { ...createTestJob(), visibilityTimeout: 60000 };
      await backend.enqueue(job);
      await backend.dequeue();

      const released = await backend.releaseTimedOutJobs();
      expect(released).toBe(0);
    });
  });

  describe('healthCheck', () => {
    it('should return healthy status when connected', async () => {
      const health = await backend.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details?.connected).toBe(true);
    });

    it('should include queue depth in health check', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());

      const health = await backend.healthCheck();
      expect(health.details?.queueDepth).toBe(2);
    });
  });
});
