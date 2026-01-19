/**
 * Redis queue backend implementation.
 * Uses sorted sets for priority queuing with FIFO ordering within priorities.
 */

import { Redis } from 'ioredis';
import type { QueueBackend, HealthCheckResult } from './backend.interface.js';
import type { Job, JobPriority } from '../types.js';
import type { RedisConfig } from '../../types/config.js';

/** Redis key prefixes for the scheduler */
export const SCHEDULER_KEYS = {
  /** Job data storage (Hash) */
  JOB: 'scheduler:job:',

  /** High priority queue (Sorted Set) */
  QUEUE_HIGH: 'scheduler:queue:high',

  /** Normal priority queue (Sorted Set) */
  QUEUE_NORMAL: 'scheduler:queue:normal',

  /** Low priority queue (Sorted Set) */
  QUEUE_LOW: 'scheduler:queue:low',

  /** Processing jobs (Sorted Set with visibleAt score) */
  PROCESSING: 'scheduler:processing',

  /** Dead letter queue (Sorted Set) */
  DLQ: 'scheduler:dlq',
} as const;

/** Priority offsets for score calculation - lower is higher priority */
const PRIORITY_OFFSETS: Record<JobPriority, number> = {
  high: 0,
  normal: 1_000_000_000_000, // 1 trillion
  low: 2_000_000_000_000, // 2 trillion
};

/**
 * Get the queue key for a given priority.
 */
function getQueueKey(priority: JobPriority): string {
  switch (priority) {
    case 'high':
      return SCHEDULER_KEYS.QUEUE_HIGH;
    case 'normal':
      return SCHEDULER_KEYS.QUEUE_NORMAL;
    case 'low':
      return SCHEDULER_KEYS.QUEUE_LOW;
  }
}

/**
 * Calculate score for sorted set.
 * Score = priority offset + timestamp for FIFO within priority.
 */
function calculateScore(priority: JobPriority): number {
  return PRIORITY_OFFSETS[priority] + Date.now();
}

/**
 * Redis implementation of the queue backend.
 * Uses sorted sets for priority-based queuing.
 */
export class RedisBackend implements QueueBackend {
  private client: Redis;
  private connected = false;
  private lastError?: string;

  constructor(config: RedisConfig) {
    this.client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      lazyConnect: true,
    });
  }

  // ============ Lifecycle ============

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
    this.lastError = undefined;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.quit();
    this.connected = false;
  }

  // ============ Core Queue Operations ============

  async enqueue(job: Job): Promise<void> {
    const jobKey = `${SCHEDULER_KEYS.JOB}${job.id}`;
    const queueKey = getQueueKey(job.priority);
    const score = calculateScore(job.priority);

    // Store job data as hash
    await this.client.hset(jobKey, this.jobToHash(job));

    // Add to priority queue
    await this.client.zadd(queueKey, score, job.id);
  }

  async dequeue(priority?: JobPriority): Promise<Job | undefined> {
    // Priority order: high > normal > low
    const queues: JobPriority[] = priority
      ? [priority]
      : ['high', 'normal', 'low'];

    for (const p of queues) {
      const queueKey = getQueueKey(p);

      // Pop the lowest score (oldest job at this priority)
      const result = await this.client.zpopmin(queueKey);

      if (result && result.length >= 2) {
        const jobId = result[0];
        if (!jobId) continue;

        const job = await this.getJob(jobId);

        if (job) {
          // Set visibility timeout
          const visibleAt = Date.now() + job.visibilityTimeout;
          const updatedJob: Job = {
            ...job,
            status: 'processing',
            startedAt: job.startedAt ?? new Date().toISOString(),
            visibleAt,
          };

          // Update job and add to processing set
          await this.updateJobInternal(jobId, updatedJob);
          await this.client.zadd(SCHEDULER_KEYS.PROCESSING, String(visibleAt), jobId);

          return updatedJob;
        }
      }
    }

    return undefined;
  }

  async acknowledge(jobId: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) return;

    // Remove from processing set
    await this.client.zrem(SCHEDULER_KEYS.PROCESSING, jobId);

    // Update job status
    const updatedJob: Job = {
      ...job,
      status: 'completed',
      completedAt: new Date().toISOString(),
      visibleAt: undefined,
    };

    await this.updateJobInternal(jobId, updatedJob);
  }

  async nack(jobId: string, error: string): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) return;

    // Remove from processing set
    await this.client.zrem(SCHEDULER_KEYS.PROCESSING, jobId);

    const newAttempts = job.attempts + 1;
    const shouldDie = newAttempts >= job.maxAttempts;

    const updatedJob: Job = {
      ...job,
      attempts: newAttempts,
      error,
      status: shouldDie ? 'dead' : 'pending',
      completedAt: shouldDie ? new Date().toISOString() : undefined,
      visibleAt: undefined,
    };

    await this.updateJobInternal(jobId, updatedJob);

    if (shouldDie) {
      // Add to dead letter queue
      await this.client.zadd(SCHEDULER_KEYS.DLQ, Date.now(), jobId);
    } else {
      // Re-queue at the back of the priority queue
      const queueKey = getQueueKey(job.priority);
      const score = calculateScore(job.priority);
      await this.client.zadd(queueKey, score, jobId);
    }
  }

  // ============ Job Management ============

  async getJob(id: string): Promise<Job | undefined> {
    const jobKey = `${SCHEDULER_KEYS.JOB}${id}`;
    const data = await this.client.hgetall(jobKey);

    if (!data || Object.keys(data).length === 0) {
      return undefined;
    }

    return this.hashToJob(data);
  }

  async updateJob(id: string, update: Partial<Job>): Promise<void> {
    const job = await this.getJob(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }

    const updatedJob = { ...job, ...update };
    await this.updateJobInternal(id, updatedJob);
  }

  private async updateJobInternal(id: string, job: Job): Promise<void> {
    const jobKey = `${SCHEDULER_KEYS.JOB}${id}`;
    await this.client.hset(jobKey, this.jobToHash(job));
  }

  // ============ Queue Info ============

  async getQueueDepth(priority?: JobPriority): Promise<number> {
    if (priority) {
      const queueKey = getQueueKey(priority);
      return this.client.zcard(queueKey);
    }

    // Total across all queues
    const [high, normal, low] = await Promise.all([
      this.client.zcard(SCHEDULER_KEYS.QUEUE_HIGH),
      this.client.zcard(SCHEDULER_KEYS.QUEUE_NORMAL),
      this.client.zcard(SCHEDULER_KEYS.QUEUE_LOW),
    ]);

    return high + normal + low;
  }

  async getProcessingCount(): Promise<number> {
    return this.client.zcard(SCHEDULER_KEYS.PROCESSING);
  }

  // ============ Dead Letter Operations ============

  async getDeadLetterJobs(): Promise<Job[]> {
    const jobIds = await this.client.zrange(SCHEDULER_KEYS.DLQ, 0, -1);
    const jobs: Job[] = [];

    for (const jobId of jobIds) {
      const job = await this.getJob(jobId);
      if (job) {
        jobs.push(job);
      }
    }

    return jobs;
  }

  async retryDeadLetter(jobId: string): Promise<void> {
    // Check if in DLQ
    const rank = await this.client.zrank(SCHEDULER_KEYS.DLQ, jobId);
    if (rank === null) {
      throw new Error(`Job ${jobId} is not in dead letter queue`);
    }

    const job = await this.getJob(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // Remove from DLQ
    await this.client.zrem(SCHEDULER_KEYS.DLQ, jobId);

    // Reset job state
    const updatedJob: Job = {
      ...job,
      status: 'pending',
      attempts: 0,
      error: undefined,
      completedAt: undefined,
      visibleAt: undefined,
    };

    await this.updateJobInternal(jobId, updatedJob);

    // Re-queue
    const queueKey = getQueueKey(job.priority);
    const score = calculateScore(job.priority);
    await this.client.zadd(queueKey, score, jobId);
  }

  // ============ Visibility Timeout ============

  async refreshVisibility(jobId: string, timeoutMs: number): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job) return;

    const visibleAt = Date.now() + timeoutMs;

    // Update job
    const updatedJob: Job = { ...job, visibleAt };
    await this.updateJobInternal(jobId, updatedJob);

    // Update score in processing set
    await this.client.zadd(SCHEDULER_KEYS.PROCESSING, visibleAt, jobId);
  }

  async releaseTimedOutJobs(): Promise<number> {
    const now = Date.now();

    // Get all jobs with visibleAt <= now
    const jobIds = await this.client.zrangebyscore(
      SCHEDULER_KEYS.PROCESSING,
      0,
      now
    );

    if (jobIds.length === 0) {
      return 0;
    }

    let released = 0;

    for (const jobId of jobIds) {
      const job = await this.getJob(jobId);
      if (!job) continue;

      // Remove from processing
      await this.client.zrem(SCHEDULER_KEYS.PROCESSING, jobId);

      // Update job status
      const updatedJob: Job = {
        ...job,
        status: 'pending',
        visibleAt: undefined,
      };
      await this.updateJobInternal(jobId, updatedJob);

      // Re-queue
      const queueKey = getQueueKey(job.priority);
      const score = calculateScore(job.priority);
      await this.client.zadd(queueKey, score, jobId);

      released++;
    }

    return released;
  }

  // ============ Health Check ============

  async healthCheck(): Promise<HealthCheckResult> {
    try {
      await this.client.ping();
      const queueDepth = await this.getQueueDepth();

      return {
        healthy: true,
        details: {
          connected: true,
          queueDepth,
          lastError: this.lastError,
        },
      };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return {
        healthy: false,
        details: {
          connected: false,
          queueDepth: 0,
          lastError: this.lastError,
        },
      };
    }
  }

  // ============ Serialization Helpers ============

  private jobToHash(job: Job): Record<string, string> {
    return {
      id: job.id,
      workflowId: job.workflowId,
      stepId: job.stepId,
      type: job.type,
      status: job.status,
      priority: job.priority,
      attempts: String(job.attempts),
      maxAttempts: String(job.maxAttempts),
      payload: JSON.stringify(job.payload),
      result: job.result !== undefined ? JSON.stringify(job.result) : '',
      error: job.error ?? '',
      createdAt: job.createdAt,
      startedAt: job.startedAt ?? '',
      completedAt: job.completedAt ?? '',
      visibilityTimeout: String(job.visibilityTimeout),
      visibleAt: job.visibleAt !== undefined ? String(job.visibleAt) : '',
    };
  }

  private hashToJob(data: Record<string, string>): Job {
    return {
      id: data.id ?? '',
      workflowId: data.workflowId ?? '',
      stepId: data.stepId ?? '',
      type: (data.type ?? 'agent') as Job['type'],
      status: (data.status ?? 'pending') as Job['status'],
      priority: (data.priority ?? 'normal') as Job['priority'],
      attempts: parseInt(data.attempts ?? '0', 10),
      maxAttempts: parseInt(data.maxAttempts ?? '3', 10),
      payload: data.payload ? JSON.parse(data.payload) : null,
      result: data.result ? JSON.parse(data.result) : undefined,
      error: data.error || undefined,
      createdAt: data.createdAt ?? new Date().toISOString(),
      startedAt: data.startedAt || undefined,
      completedAt: data.completedAt || undefined,
      visibilityTimeout: parseInt(data.visibilityTimeout ?? '30000', 10),
      visibleAt: data.visibleAt ? parseInt(data.visibleAt, 10) : undefined,
    };
  }
}
