/**
 * Redis-backed job queue implementation for the orchestrator server.
 * Provides persistent job storage with priority-based ordering using Redis sorted sets.
 */

import IORedis from 'ioredis';
const Redis = IORedis.default ?? IORedis;
import type { Job, JobStatus, JobResult, JobPriority } from './types.js';
import type { JobQueue } from './job-queue.js';

/**
 * Priority ordering: urgent > high > normal > low
 * Score = priority * 1e13 + (1e13 - timestamp_ms) to get priority-first, FIFO within same priority
 */
const PRIORITY_WEIGHT: Record<JobPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const KEY_PREFIX = 'orchestrator';
const JOB_KEY = (id: string) => `${KEY_PREFIX}:job:${id}`;
const PENDING_QUEUE = `${KEY_PREFIX}:queue:pending`;

/**
 * Lua script for atomic poll operation.
 * Finds the highest-priority pending job matching worker capabilities,
 * removes it from the pending set, and updates its status to 'assigned'.
 *
 * KEYS[1] = pending queue sorted set
 * ARGV[1] = worker ID
 * ARGV[2] = comma-separated capabilities (empty string = match all)
 * ARGV[3] = current ISO timestamp
 * ARGV[4] = job key prefix
 *
 * Returns: job JSON string or nil
 */
const POLL_SCRIPT = `
local pending_key = KEYS[1]
local worker_id = ARGV[1]
local caps_str = ARGV[2]
local now = ARGV[3]
local prefix = ARGV[4]

-- Get all pending job IDs sorted by score (highest priority first)
local members = redis.call('ZREVRANGE', pending_key, 0, -1)
if #members == 0 then
  return nil
end

-- Parse capabilities
local caps = {}
local match_all = (caps_str == '' or caps_str == '*')
if not match_all then
  for cap in string.gmatch(caps_str, '([^,]+)') do
    caps[cap] = true
  end
end

for _, job_id in ipairs(members) do
  local job_key = prefix .. ':job:' .. job_id
  local job_json = redis.call('GET', job_key)

  if job_json then
    local job = cjson.decode(job_json)

    -- Verify still pending
    if job.status == 'pending' then
      -- Check capability match
      local matched = match_all
      if not matched then
        local tags = job.tags
        if tags == nil or #tags == 0 then
          matched = true
        else
          for _, tag in ipairs(tags) do
            if caps[tag] then
              matched = true
              break
            end
          end
        end
      end

      if matched then
        -- Remove from pending queue
        redis.call('ZREM', pending_key, job_id)

        -- Update job status
        job.status = 'assigned'
        job.assignedAt = now
        job.workerId = worker_id

        local updated_json = cjson.encode(job)
        redis.call('SET', job_key, updated_json)

        return updated_json
      end
    else
      -- Stale entry, clean up
      redis.call('ZREM', pending_key, job_id)
    end
  else
    -- Job key missing, clean up
    redis.call('ZREM', pending_key, job_id)
  end
end

return nil
`;

/**
 * Redis-backed job queue implementation.
 * Jobs survive orchestrator restarts as long as Redis persists.
 */
export class RedisJobQueue implements JobQueue {
  private redis: InstanceType<typeof Redis>;
  private isConnected = false;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        if (times > 10) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      this.isConnected = true;
    });

    this.redis.on('close', () => {
      this.isConnected = false;
    });
  }

  /**
   * Connect to Redis. Must be called before using the queue.
   * Throws if connection fails.
   */
  async connect(): Promise<void> {
    await this.redis.connect();
    // Verify connection with a ping
    await this.redis.ping();
    this.isConnected = true;
  }

  /**
   * Disconnect from Redis.
   */
  async close(): Promise<void> {
    if (this.isConnected) {
      this.redis.disconnect();
      this.isConnected = false;
    }
  }

  /**
   * Compute sorted set score: priority-first, FIFO within same priority.
   */
  private computeScore(priority: JobPriority): number {
    const weight = PRIORITY_WEIGHT[priority];
    // Use priority as the integer part, and inverse timestamp fraction for FIFO
    // score = priority * 1e13 + (1e13 - Date.now())
    // This ensures higher priority always wins, and within same priority, earlier jobs score higher
    return weight * 1e13 + (1e13 - Date.now());
  }

  async enqueue(job: Job): Promise<void> {
    const key = JOB_KEY(job.id);
    await this.redis.set(key, JSON.stringify(job));

    if (job.status === 'pending') {
      const score = this.computeScore(job.priority);
      await this.redis.zadd(PENDING_QUEUE, score.toString(), job.id);
    }
  }

  async poll(workerId: string, capabilities: string[]): Promise<Job | null> {
    const capsStr = capabilities.length === 0 ? '' : capabilities.join(',');
    const now = new Date().toISOString();

    const result = await this.redis.eval(
      POLL_SCRIPT,
      1,
      PENDING_QUEUE,
      workerId,
      capsStr,
      now,
      KEY_PREFIX,
    ) as string | null;

    if (!result) return null;

    return JSON.parse(result) as Job;
  }

  async updateStatus(
    jobId: string,
    status: JobStatus,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const key = JOB_KEY(jobId);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const job = JSON.parse(raw) as Job;
    const now = new Date().toISOString();

    job.status = status;

    switch (status) {
      case 'running':
        job.startedAt = now;
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        job.completedAt = now;
        break;
      case 'assigned':
        job.assignedAt = now;
        break;
    }

    if (metadata) {
      job.metadata = { ...job.metadata, ...metadata };
    }

    await this.redis.set(key, JSON.stringify(job));

    // If job goes back to pending, re-add to sorted set
    if (status === 'pending') {
      const score = this.computeScore(job.priority);
      await this.redis.zadd(PENDING_QUEUE, score.toString(), jobId);
    } else {
      // Remove from pending if it was there
      await this.redis.zrem(PENDING_QUEUE, jobId);
    }
  }

  async reportResult(jobId: string, result: JobResult): Promise<void> {
    const key = JOB_KEY(jobId);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const job = JSON.parse(raw) as Job;
    const now = new Date().toISOString();

    job.status = result.status;
    job.completedAt = now;

    job.metadata = {
      ...job.metadata,
      result: {
        outputs: result.outputs,
        error: result.error,
        errorStack: result.errorStack,
        duration: result.duration,
        phases: result.phases,
        steps: result.steps,
      },
    };

    await this.redis.set(key, JSON.stringify(job));
    await this.redis.zrem(PENDING_QUEUE, jobId);
  }

  async getJob(jobId: string): Promise<Job | null> {
    const raw = await this.redis.get(JOB_KEY(jobId));
    if (!raw) return null;
    return JSON.parse(raw) as Job;
  }

  async cancelJob(jobId: string, reason?: string): Promise<void> {
    const key = JOB_KEY(jobId);
    const raw = await this.redis.get(key);
    if (!raw) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const job = JSON.parse(raw) as Job;

    const terminalStates: JobStatus[] = ['completed', 'failed', 'cancelled'];
    if (terminalStates.includes(job.status)) {
      return;
    }

    const now = new Date().toISOString();
    job.status = 'cancelled';
    job.completedAt = now;

    if (reason) {
      job.metadata = { ...job.metadata, cancellationReason: reason };
    }

    await this.redis.set(key, JSON.stringify(job));
    await this.redis.zrem(PENDING_QUEUE, jobId);
  }
}

/**
 * Create a job queue, preferring Redis if a URL is provided.
 * Falls back to InMemoryJobQueue if Redis connection fails.
 */
export async function createJobQueue(
  redisUrl: string | undefined,
  logger?: { info: (msg: string, data?: Record<string, unknown>) => void; warn: (msg: string, data?: Record<string, unknown>) => void },
): Promise<JobQueue> {
  if (redisUrl) {
    try {
      const queue = new RedisJobQueue(redisUrl);
      await queue.connect();
      (logger?.info ?? console.log)('[JobQueue] Connected to Redis', { url: redisUrl });
      return queue;
    } catch (error) {
      (logger?.warn ?? console.warn)(
        `[JobQueue] Failed to connect to Redis (${error instanceof Error ? error.message : String(error)}), falling back to in-memory queue`,
      );
    }
  }

  const { InMemoryJobQueue } = await import('./job-queue.js');
  return new InMemoryJobQueue();
}
