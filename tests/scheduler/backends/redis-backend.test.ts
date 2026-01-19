/**
 * Integration tests for the Redis queue backend.
 * These tests require a running Redis instance.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { Redis } from 'ioredis';
import { RedisBackend, SCHEDULER_KEYS } from '../../../src/scheduler/backends/redis-backend.js';
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

describe('RedisBackend', () => {
  let backend: RedisBackend;
  let redis: Redis;
  const testConfig = {
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  };

  beforeAll(async () => {
    // Test Redis connectivity
    redis = new Redis({
      ...testConfig,
      lazyConnect: true,
    });

    try {
      await redis.connect();
    } catch {
      // Redis not available - tests will be skipped
    }
  });

  afterAll(async () => {
    await redis?.quit();
  });

  beforeEach(async () => {
    if (!redis || redis.status !== 'ready') {
      return;
    }

    // Clean up test keys
    const keys = await redis.keys(`${SCHEDULER_KEYS.JOB}*`);
    const queueKeys = [
      SCHEDULER_KEYS.QUEUE_HIGH,
      SCHEDULER_KEYS.QUEUE_NORMAL,
      SCHEDULER_KEYS.QUEUE_LOW,
      SCHEDULER_KEYS.PROCESSING,
      SCHEDULER_KEYS.DLQ,
    ];
    const allKeys = [...keys, ...queueKeys];
    if (allKeys.length > 0) {
      await redis.del(...allKeys);
    }

    backend = new RedisBackend(testConfig);
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) {
      await backend.disconnect();
    }
  });

  // Skip tests if Redis is not available
  const itIfRedis = redis?.status === 'ready' ? it : it.skip;

  describe('connect/disconnect', () => {
    itIfRedis('should connect successfully', async () => {
      const newBackend = new RedisBackend(testConfig);
      await expect(newBackend.connect()).resolves.toBeUndefined();
      await newBackend.disconnect();
    });

    itIfRedis('should disconnect successfully', async () => {
      await expect(backend.disconnect()).resolves.toBeUndefined();
    });
  });

  describe('enqueue', () => {
    itIfRedis('should enqueue a job', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(job.id);
    });

    itIfRedis('should store job with all properties', async () => {
      const job = createTestJob({ priority: 'high' });
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved?.workflowId).toBe(job.workflowId);
      expect(retrieved?.stepId).toBe(job.stepId);
      expect(retrieved?.type).toBe(job.type);
      expect(retrieved?.priority).toBe('high');
      expect(retrieved?.payload).toEqual(job.payload);
    });

    itIfRedis('should add job to correct priority queue', async () => {
      const job = createTestJob({ priority: 'high' });
      await backend.enqueue(job);

      const depth = await backend.getQueueDepth('high');
      expect(depth).toBe(1);
    });
  });

  describe('dequeue', () => {
    itIfRedis('should return undefined when queue is empty', async () => {
      const job = await backend.dequeue();
      expect(job).toBeUndefined();
    });

    itIfRedis('should dequeue a job and set visibility timeout', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const dequeued = await backend.dequeue();
      expect(dequeued).toBeDefined();
      expect(dequeued?.id).toBe(job.id);
      expect(dequeued?.status).toBe('processing');
      expect(dequeued?.visibleAt).toBeDefined();
    });

    itIfRedis('should filter by priority when specified', async () => {
      const highJob = { ...createTestJob(), priority: 'high' as const };
      const normalJob = { ...createTestJob(), priority: 'normal' as const };

      await backend.enqueue(normalJob);
      await backend.enqueue(highJob);

      const dequeued = await backend.dequeue('normal');
      expect(dequeued?.id).toBe(normalJob.id);
    });
  });

  describe('priority ordering', () => {
    itIfRedis('should dequeue high priority jobs before normal', async () => {
      const normalJob = { ...createTestJob(), priority: 'normal' as const };
      const highJob = { ...createTestJob(), priority: 'high' as const };

      // Enqueue normal first, then high
      await backend.enqueue(normalJob);
      await backend.enqueue(highJob);

      const first = await backend.dequeue();
      expect(first?.priority).toBe('high');
    });

    itIfRedis('should dequeue normal priority jobs before low', async () => {
      const lowJob = { ...createTestJob(), priority: 'low' as const };
      const normalJob = { ...createTestJob(), priority: 'normal' as const };

      await backend.enqueue(lowJob);
      await backend.enqueue(normalJob);

      const first = await backend.dequeue();
      expect(first?.priority).toBe('normal');
    });

    itIfRedis('should maintain FIFO within same priority level', async () => {
      const high1 = { ...createTestJob(), priority: 'high' as const };
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      const high2 = { ...createTestJob(), priority: 'high' as const };
      await new Promise(r => setTimeout(r, 10));
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
    itIfRedis('should remove job from processing set', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      const processingBefore = await backend.getProcessingCount();
      expect(processingBefore).toBe(1);

      await backend.acknowledge(job.id);

      const processingAfter = await backend.getProcessingCount();
      expect(processingAfter).toBe(0);
    });

    itIfRedis('should update job status to completed', async () => {
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
    itIfRedis('should increment attempts count', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      await backend.nack(job.id, 'Test error');

      const updated = await backend.getJob(job.id);
      expect(updated?.attempts).toBe(1);
      expect(updated?.error).toBe('Test error');
    });

    itIfRedis('should re-queue job if under max attempts', async () => {
      const job = { ...createTestJob(), maxAttempts: 3 };
      await backend.enqueue(job);
      await backend.dequeue();

      await backend.nack(job.id, 'Test error');

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('pending');

      const dequeued = await backend.dequeue();
      expect(dequeued?.id).toBe(job.id);
    });

    itIfRedis('should move to dead letter if max attempts reached', async () => {
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
    itIfRedis('should return undefined for non-existent job', async () => {
      const job = await backend.getJob('non-existent');
      expect(job).toBeUndefined();
    });

    itIfRedis('should return job by id', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const retrieved = await backend.getJob(job.id);
      expect(retrieved?.id).toBe(job.id);
    });
  });

  describe('updateJob', () => {
    itIfRedis('should update job properties', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      await backend.updateJob(job.id, { result: { success: true } });

      const updated = await backend.getJob(job.id);
      expect(updated?.result).toEqual({ success: true });
    });

    itIfRedis('should throw for non-existent job', async () => {
      await expect(
        backend.updateJob('non-existent', { result: 'test' })
      ).rejects.toThrow('Job not found');
    });
  });

  describe('getQueueDepth', () => {
    itIfRedis('should return 0 for empty queue', async () => {
      const depth = await backend.getQueueDepth();
      expect(depth).toBe(0);
    });

    itIfRedis('should return total queue depth', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());

      const depth = await backend.getQueueDepth();
      expect(depth).toBe(2);
    });

    itIfRedis('should return depth for specific priority', async () => {
      await backend.enqueue({ ...createTestJob(), priority: 'high' });
      await backend.enqueue({ ...createTestJob(), priority: 'normal' });
      await backend.enqueue({ ...createTestJob(), priority: 'normal' });

      const highDepth = await backend.getQueueDepth('high');
      const normalDepth = await backend.getQueueDepth('normal');

      expect(highDepth).toBe(1);
      expect(normalDepth).toBe(2);
    });

    itIfRedis('should not count processing jobs', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());
      await backend.dequeue();

      const depth = await backend.getQueueDepth();
      expect(depth).toBe(1);
    });
  });

  describe('dead letter operations', () => {
    itIfRedis('should return empty array when no dead jobs', async () => {
      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toEqual([]);
    });

    itIfRedis('should return dead letter jobs', async () => {
      const job = { ...createTestJob(), maxAttempts: 1 };
      await backend.enqueue(job);
      await backend.dequeue();
      await backend.nack(job.id, 'Fatal error');

      const dlq = await backend.getDeadLetterJobs();
      expect(dlq).toHaveLength(1);
      expect(dlq[0].status).toBe('dead');
    });

    itIfRedis('should retry dead letter job', async () => {
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

    itIfRedis('should throw when retrying non-dead job', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      await expect(backend.retryDeadLetter(job.id)).rejects.toThrow('not in dead letter queue');
    });
  });

  describe('visibility timeout', () => {
    itIfRedis('should set visibleAt on dequeue', async () => {
      const job = createTestJob();
      await backend.enqueue(job);

      const dequeued = await backend.dequeue();
      expect(dequeued?.visibleAt).toBeDefined();
      expect(dequeued?.visibleAt).toBeGreaterThan(Date.now());
    });

    itIfRedis('should refresh visibility timeout', async () => {
      const job = createTestJob();
      await backend.enqueue(job);
      await backend.dequeue();

      const before = (await backend.getJob(job.id))?.visibleAt;
      await backend.refreshVisibility(job.id, 60000);
      const after = (await backend.getJob(job.id))?.visibleAt;

      expect(after).toBeGreaterThan(before!);
    });

    itIfRedis('should release timed out jobs', async () => {
      // Create job with very short timeout
      const job = { ...createTestJob(), visibilityTimeout: 100 };
      await backend.enqueue(job);
      await backend.dequeue();

      // Wait for timeout to expire
      await new Promise(r => setTimeout(r, 200));

      const released = await backend.releaseTimedOutJobs();
      expect(released).toBe(1);

      const updated = await backend.getJob(job.id);
      expect(updated?.status).toBe('pending');
    });

    itIfRedis('should not release jobs within visibility timeout', async () => {
      const job = { ...createTestJob(), visibilityTimeout: 60000 };
      await backend.enqueue(job);
      await backend.dequeue();

      const released = await backend.releaseTimedOutJobs();
      expect(released).toBe(0);
    });
  });

  describe('healthCheck', () => {
    itIfRedis('should return healthy status when connected', async () => {
      const health = await backend.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details?.connected).toBe(true);
    });

    itIfRedis('should include queue depth in health check', async () => {
      await backend.enqueue(createTestJob());
      await backend.enqueue(createTestJob());

      const health = await backend.healthCheck();
      expect(health.details?.queueDepth).toBe(2);
    });
  });
});
