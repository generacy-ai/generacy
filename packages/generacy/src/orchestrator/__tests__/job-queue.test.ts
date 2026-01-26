import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InMemoryJobQueue } from '../job-queue.js';
import type { Job, JobPriority, JobResult } from '../types.js';

// Mock console.warn to suppress startup warning
vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('InMemoryJobQueue', () => {
  let queue: InMemoryJobQueue;

  beforeEach(() => {
    queue = new InMemoryJobQueue();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createJob(overrides: Partial<Job> = {}): Job {
    return {
      id: 'job-1',
      name: 'Test Job',
      status: 'pending',
      priority: 'normal' as JobPriority,
      workflow: 'test.yaml',
      inputs: {},
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('enqueue', () => {
    it('should add a job to the queue', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(job.id);
      expect(retrieved?.name).toBe(job.name);
    });

    it('should store a copy of the job, not a reference', async () => {
      const job = createJob();
      await queue.enqueue(job);

      // Modify the original job
      job.name = 'Modified Name';

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.name).toBe('Test Job');
    });

    it('should maintain priority order - urgent > high > normal > low', async () => {
      const lowJob = createJob({ id: 'low', priority: 'low' });
      const normalJob = createJob({ id: 'normal', priority: 'normal' });
      const highJob = createJob({ id: 'high', priority: 'high' });
      const urgentJob = createJob({ id: 'urgent', priority: 'urgent' });

      // Enqueue in random order
      await queue.enqueue(normalJob);
      await queue.enqueue(lowJob);
      await queue.enqueue(urgentJob);
      await queue.enqueue(highJob);

      // Poll should return jobs in priority order
      const first = await queue.poll('worker-1', ['*']);
      expect(first?.id).toBe('urgent');

      const second = await queue.poll('worker-1', ['*']);
      expect(second?.id).toBe('high');

      const third = await queue.poll('worker-1', ['*']);
      expect(third?.id).toBe('normal');

      const fourth = await queue.poll('worker-1', ['*']);
      expect(fourth?.id).toBe('low');
    });

    it('should not add non-pending jobs to the pending queue', async () => {
      const runningJob = createJob({ id: 'running', status: 'running' });
      await queue.enqueue(runningJob);

      const polled = await queue.poll('worker-1', ['*']);
      expect(polled).toBeNull();

      // But the job should still be retrievable
      const retrieved = await queue.getJob('running');
      expect(retrieved).not.toBeNull();
    });

    it('should insert jobs with same priority in FIFO order', async () => {
      const job1 = createJob({ id: 'first', priority: 'normal' });
      const job2 = createJob({ id: 'second', priority: 'normal' });
      const job3 = createJob({ id: 'third', priority: 'normal' });

      await queue.enqueue(job1);
      await queue.enqueue(job2);
      await queue.enqueue(job3);

      const first = await queue.poll('worker-1', ['*']);
      expect(first?.id).toBe('first');

      const second = await queue.poll('worker-1', ['*']);
      expect(second?.id).toBe('second');

      const third = await queue.poll('worker-1', ['*']);
      expect(third?.id).toBe('third');
    });
  });

  describe('poll', () => {
    it('should return the highest priority job', async () => {
      const normalJob = createJob({ id: 'normal', priority: 'normal' });
      const highJob = createJob({ id: 'high', priority: 'high' });

      await queue.enqueue(normalJob);
      await queue.enqueue(highJob);

      const polled = await queue.poll('worker-1', ['*']);
      expect(polled?.id).toBe('high');
      expect(polled?.priority).toBe('high');
    });

    it('should return null when no jobs are available', async () => {
      const polled = await queue.poll('worker-1', ['*']);
      expect(polled).toBeNull();
    });

    it('should return null when queue is empty after all jobs are polled', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const first = await queue.poll('worker-1', ['*']);
      expect(first).not.toBeNull();

      const second = await queue.poll('worker-1', ['*']);
      expect(second).toBeNull();
    });

    it('should assign job to the polling worker', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const polled = await queue.poll('worker-123', ['*']);
      expect(polled?.workerId).toBe('worker-123');
      expect(polled?.status).toBe('assigned');
      expect(polled?.assignedAt).toBeDefined();
    });

    it('should skip jobs that do not match worker capabilities', async () => {
      const pythonJob = createJob({ id: 'python-job', tags: ['python'] });
      const nodeJob = createJob({ id: 'node-job', tags: ['node'] });

      await queue.enqueue(pythonJob);
      await queue.enqueue(nodeJob);

      // Worker with node capability should only get the node job
      const polled = await queue.poll('worker-1', ['node']);
      expect(polled?.id).toBe('node-job');

      // Python job should still be in queue
      const pythonPolled = await queue.poll('worker-2', ['python']);
      expect(pythonPolled?.id).toBe('python-job');
    });

    it('should match jobs without tags to any worker', async () => {
      const untaggedJob = createJob({ id: 'untagged' });
      await queue.enqueue(untaggedJob);

      const polled = await queue.poll('worker-1', ['python']);
      expect(polled?.id).toBe('untagged');
    });

    it('should allow wildcard capability to match any job', async () => {
      const taggedJob = createJob({ id: 'tagged', tags: ['special'] });
      await queue.enqueue(taggedJob);

      const polled = await queue.poll('worker-1', ['*']);
      expect(polled?.id).toBe('tagged');
    });

    it('should allow empty capabilities to match any job', async () => {
      const taggedJob = createJob({ id: 'tagged', tags: ['special'] });
      await queue.enqueue(taggedJob);

      const polled = await queue.poll('worker-1', []);
      expect(polled?.id).toBe('tagged');
    });

    it('should match if any job tag matches any worker capability', async () => {
      const multiTagJob = createJob({ id: 'multi', tags: ['python', 'ml', 'data'] });
      await queue.enqueue(multiTagJob);

      const polled = await queue.poll('worker-1', ['ml']);
      expect(polled?.id).toBe('multi');
    });

    it('should return a copy of the job', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const polled = await queue.poll('worker-1', ['*']);
      expect(polled).not.toBeNull();

      // Modify the polled job
      if (polled) {
        polled.name = 'Modified';
      }

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.name).toBe('Test Job');
    });

    it('should remove job from pending queue after polling', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.poll('worker-1', ['*']);

      // Polling again should return null
      const second = await queue.poll('worker-2', ['*']);
      expect(second).toBeNull();
    });

    it('should handle jobs with empty tags array like untagged jobs', async () => {
      const emptyTagsJob = createJob({ id: 'empty-tags', tags: [] });
      await queue.enqueue(emptyTagsJob);

      const polled = await queue.poll('worker-1', ['python']);
      expect(polled?.id).toBe('empty-tags');
    });
  });

  describe('updateStatus', () => {
    it('should update job status', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'running');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('running');
    });

    it('should set startedAt when status changes to running', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'running');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.startedAt).toBeDefined();
    });

    it('should set completedAt when status changes to completed', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'completed');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('should set completedAt when status changes to failed', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'failed');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('should set completedAt when status changes to cancelled', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'cancelled');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('should set assignedAt when status changes to assigned', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'assigned');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.assignedAt).toBeDefined();
    });

    it('should merge metadata when provided', async () => {
      const job = createJob({ metadata: { existing: 'value' } });
      await queue.enqueue(job);

      await queue.updateStatus(job.id, 'running', { newKey: 'newValue' });

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.metadata?.existing).toBe('value');
      expect(retrieved?.metadata?.newKey).toBe('newValue');
    });

    it('should throw error for non-existent job', async () => {
      await expect(queue.updateStatus('non-existent', 'running')).rejects.toThrow(
        'Job not found: non-existent'
      );
    });

    it('should re-add job to pending queue when status changes back to pending', async () => {
      const job = createJob();
      await queue.enqueue(job);

      // Poll to remove from queue and assign
      await queue.poll('worker-1', ['*']);

      // Update back to pending
      await queue.updateStatus(job.id, 'pending');

      // Should be pollable again
      const polled = await queue.poll('worker-2', ['*']);
      expect(polled?.id).toBe(job.id);
    });
  });

  describe('reportResult', () => {
    it('should store result in job metadata', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'completed',
        outputs: { message: 'success' },
        duration: 1000,
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.metadata?.result).toBeDefined();
      expect((retrieved?.metadata?.result as Record<string, unknown>).outputs).toEqual({
        message: 'success',
      });
      expect((retrieved?.metadata?.result as Record<string, unknown>).duration).toBe(1000);
    });

    it('should update job status from result', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'completed',
        duration: 1000,
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('completed');
    });

    it('should set completedAt timestamp', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'completed',
        duration: 1000,
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('should store error information for failed jobs', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'failed',
        error: 'Something went wrong',
        errorStack: 'Error: Something went wrong\n  at test.js:1:1',
        duration: 500,
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('failed');
      expect((retrieved?.metadata?.result as Record<string, unknown>).error).toBe(
        'Something went wrong'
      );
      expect((retrieved?.metadata?.result as Record<string, unknown>).errorStack).toBe(
        'Error: Something went wrong\n  at test.js:1:1'
      );
    });

    it('should store phase and step results', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'completed',
        duration: 2000,
        phases: [
          { name: 'setup', status: 'completed', duration: 500 },
          { name: 'execute', status: 'completed', duration: 1500 },
        ],
        steps: [
          { name: 'step-1', status: 'completed', duration: 300 },
          { name: 'step-2', status: 'completed', duration: 700 },
        ],
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      const resultData = retrieved?.metadata?.result as Record<string, unknown>;
      expect(resultData.phases).toHaveLength(2);
      expect(resultData.steps).toHaveLength(2);
    });

    it('should throw error for non-existent job', async () => {
      const result: JobResult = {
        jobId: 'non-existent',
        status: 'completed',
        duration: 1000,
      };

      await expect(queue.reportResult('non-existent', result)).rejects.toThrow(
        'Job not found: non-existent'
      );
    });

    it('should preserve existing metadata when reporting result', async () => {
      const job = createJob({ metadata: { existingKey: 'existingValue' } });
      await queue.enqueue(job);

      const result: JobResult = {
        jobId: job.id,
        status: 'completed',
        duration: 1000,
      };

      await queue.reportResult(job.id, result);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.metadata?.existingKey).toBe('existingValue');
      expect(retrieved?.metadata?.result).toBeDefined();
    });
  });

  describe('getJob', () => {
    it('should return job by ID', async () => {
      const job = createJob({ id: 'my-job' });
      await queue.enqueue(job);

      const retrieved = await queue.getJob('my-job');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('my-job');
    });

    it('should return null for non-existent job', async () => {
      const retrieved = await queue.getJob('non-existent');
      expect(retrieved).toBeNull();
    });

    it('should return a copy of the job', async () => {
      const job = createJob();
      await queue.enqueue(job);

      const retrieved = await queue.getJob(job.id);
      if (retrieved) {
        retrieved.name = 'Modified';
      }

      const retrievedAgain = await queue.getJob(job.id);
      expect(retrievedAgain?.name).toBe('Test Job');
    });

    it('should return job with all its current data', async () => {
      const job = createJob({
        tags: ['test'],
        metadata: { key: 'value' },
        timeout: 60,
        retries: 3,
      });
      await queue.enqueue(job);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.tags).toEqual(['test']);
      expect(retrieved?.metadata).toEqual({ key: 'value' });
      expect(retrieved?.timeout).toBe(60);
      expect(retrieved?.retries).toBe(3);
    });
  });

  describe('cancelJob', () => {
    it('should cancel a pending job', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('cancelled');
    });

    it('should cancel a running job', async () => {
      const job = createJob({ status: 'running' });
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('cancelled');
    });

    it('should set completedAt when cancelling', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.completedAt).toBeDefined();
    });

    it('should store cancellation reason in metadata', async () => {
      const job = createJob();
      await queue.enqueue(job);

      await queue.cancelJob(job.id, 'User requested cancellation');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.metadata?.cancellationReason).toBe('User requested cancellation');
    });

    it('should be no-op for completed jobs', async () => {
      const job = createJob({ status: 'completed' });
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('completed');
    });

    it('should be no-op for failed jobs', async () => {
      const job = createJob({ status: 'failed' });
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('failed');
    });

    it('should be no-op for already cancelled jobs', async () => {
      const job = createJob({ status: 'cancelled' });
      await queue.enqueue(job);

      // Should not throw
      await queue.cancelJob(job.id, 'New reason');

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('cancelled');
      // Metadata should not be updated
      expect(retrieved?.metadata?.cancellationReason).toBeUndefined();
    });

    it('should remove job from pending queue when cancelled', async () => {
      const job1 = createJob({ id: 'job-1' });
      const job2 = createJob({ id: 'job-2' });

      await queue.enqueue(job1);
      await queue.enqueue(job2);

      await queue.cancelJob('job-1');

      // Only job-2 should be pollable
      const polled = await queue.poll('worker-1', ['*']);
      expect(polled?.id).toBe('job-2');

      const second = await queue.poll('worker-1', ['*']);
      expect(second).toBeNull();
    });

    it('should throw error for non-existent job', async () => {
      await expect(queue.cancelJob('non-existent')).rejects.toThrow(
        'Job not found: non-existent'
      );
    });

    it('should cancel assigned jobs', async () => {
      const job = createJob({ status: 'assigned' });
      await queue.enqueue(job);

      await queue.cancelJob(job.id);

      const retrieved = await queue.getJob(job.id);
      expect(retrieved?.status).toBe('cancelled');
    });
  });

  describe('priority ordering', () => {
    it('should process urgent jobs before high priority jobs', async () => {
      await queue.enqueue(createJob({ id: 'high', priority: 'high' }));
      await queue.enqueue(createJob({ id: 'urgent', priority: 'urgent' }));

      const first = await queue.poll('worker-1', ['*']);
      expect(first?.id).toBe('urgent');
    });

    it('should process high jobs before normal priority jobs', async () => {
      await queue.enqueue(createJob({ id: 'normal', priority: 'normal' }));
      await queue.enqueue(createJob({ id: 'high', priority: 'high' }));

      const first = await queue.poll('worker-1', ['*']);
      expect(first?.id).toBe('high');
    });

    it('should process normal jobs before low priority jobs', async () => {
      await queue.enqueue(createJob({ id: 'low', priority: 'low' }));
      await queue.enqueue(createJob({ id: 'normal', priority: 'normal' }));

      const first = await queue.poll('worker-1', ['*']);
      expect(first?.id).toBe('normal');
    });

    it('should maintain correct order with interleaved inserts', async () => {
      await queue.enqueue(createJob({ id: 'normal-1', priority: 'normal' }));
      await queue.enqueue(createJob({ id: 'urgent-1', priority: 'urgent' }));
      await queue.enqueue(createJob({ id: 'low-1', priority: 'low' }));
      await queue.enqueue(createJob({ id: 'high-1', priority: 'high' }));
      await queue.enqueue(createJob({ id: 'normal-2', priority: 'normal' }));
      await queue.enqueue(createJob({ id: 'urgent-2', priority: 'urgent' }));

      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        const job = await queue.poll('worker-1', ['*']);
        if (job) results.push(job.id);
      }

      expect(results).toEqual([
        'urgent-1',
        'urgent-2',
        'high-1',
        'normal-1',
        'normal-2',
        'low-1',
      ]);
    });
  });

  describe('constructor warning', () => {
    it('should log a warning about in-memory storage', () => {
      // Clear previous calls
      vi.clearAllMocks();

      // Create a new queue
      new InMemoryJobQueue();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Using in-memory job queue')
      );
    });
  });
});
