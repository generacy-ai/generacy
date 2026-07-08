import type { Redis } from 'ioredis';
import type { QueueItem, QueueItemWithScore, QueueManager, SerializedQueueItem } from '../types/index.js';
import type { DispatchConfig } from '../config/index.js';
import { getPriorityScore } from './queue-priority.js';

const PENDING_KEY = 'orchestrator:queue:pending';
const CLAIMED_KEY_PREFIX = 'orchestrator:queue:claimed:';
const HEARTBEAT_KEY_PREFIX = 'orchestrator:worker:';
const DEAD_LETTER_KEY = 'orchestrator:queue:dead-letter';
const IN_FLIGHT_KEY = 'orchestrator:queue:in-flight-items';

/**
 * Lua script for atomic in-flight-checked enqueue.
 * KEYS[1] = pending sorted set
 * KEYS[2] = in-flight SET
 * ARGV[1] = itemKey
 * ARGV[2] = priority (numeric string)
 * ARGV[3] = serialized item JSON
 *
 * Returns 1 if enqueued, 0 if already in flight.
 */
const ENQUEUE_IF_ABSENT_SCRIPT = `
local exists = redis.call('SISMEMBER', KEYS[2], ARGV[1])
if exists == 1 then
  return 0
end
redis.call('SADD', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
return 1
`;

/**
 * Lua script for atomic claim: ZPOPMIN + HSET claimed + SET heartbeat.
 * KEYS[1] = pending sorted set
 * KEYS[2] = claimed hash for this worker
 * KEYS[3] = heartbeat key for this worker
 * ARGV[1] = heartbeat TTL in seconds
 *
 * Returns the serialized item string, or nil if queue is empty.
 */
const CLAIM_SCRIPT = `
local result = redis.call('ZPOPMIN', KEYS[1], 1)
if #result == 0 then
  return nil
end
local member = result[1]
local parsed = cjson.decode(member)
local itemKey = parsed.itemKey
redis.call('HSET', KEYS[2], itemKey, member)
redis.call('SET', KEYS[3], '1', 'EX', tonumber(ARGV[1]))
return member
`;

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

function buildItemKey(item: QueueItem): string {
  return `${item.owner}/${item.repo}#${item.issueNumber}`;
}

function buildClaimedKey(workerId: string): string {
  return `${CLAIMED_KEY_PREFIX}${workerId}`;
}

function buildHeartbeatKey(workerId: string): string {
  return `${HEARTBEAT_KEY_PREFIX}${workerId}:heartbeat`;
}

/**
 * Redis sorted-set backed queue adapter implementing QueueManager.
 * Uses ZADD for priority ordering and a Lua script for atomic claim.
 * Gracefully degrades on Redis errors (logs warnings, doesn't crash).
 */
export class RedisQueueAdapter implements QueueManager {
  private readonly redis: Redis;
  private readonly logger: Logger;
  private readonly maxRetries: number;
  private claimCommandDefined = false;
  private enqueueIfAbsentCommandDefined = false;

  constructor(redis: Redis, logger: Logger, config?: Pick<DispatchConfig, 'maxRetries'>) {
    this.redis = redis;
    this.logger = logger;
    this.maxRetries = config?.maxRetries ?? 3;
  }

  private ensureClaimCommand(): void {
    if (this.claimCommandDefined) return;
    this.redis.defineCommand('claimItem', {
      numberOfKeys: 3,
      lua: CLAIM_SCRIPT,
    });
    this.claimCommandDefined = true;
  }

  private ensureEnqueueIfAbsentCommand(): void {
    if (this.enqueueIfAbsentCommandDefined) return;
    this.redis.defineCommand('enqueueIfAbsent', {
      numberOfKeys: 2,
      lua: ENQUEUE_IF_ABSENT_SCRIPT,
    });
    this.enqueueIfAbsentCommandDefined = true;
  }

  async enqueueIfAbsent(item: QueueItem): Promise<boolean> {
    this.ensureEnqueueIfAbsentCommand();
    const itemKey = buildItemKey(item);
    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: 0,
      itemKey,
    };

    try {
      const result = await (this.redis as any).enqueueIfAbsent(
        PENDING_KEY,
        IN_FLIGHT_KEY,
        itemKey,
        String(priority),
        JSON.stringify(serialized),
      );
      const enqueued = result === 1;
      if (enqueued) {
        this.logger.info(
          { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority, itemKey },
          'Item enqueued to Redis sorted set (in-flight-checked)',
        );
      }
      return enqueued;
    } catch (error) {
      this.logger.warn(
        { err: error, itemKey },
        'Redis error in enqueueIfAbsent, dropping (fail-safe)',
      );
      return false;
    }
  }

  async hasInFlight(itemKey: string): Promise<boolean> {
    try {
      const result = await this.redis.sismember(IN_FLIGHT_KEY, itemKey);
      return result === 1;
    } catch (error) {
      this.logger.warn({ err: error, itemKey }, 'Redis error in hasInFlight');
      return false;
    }
  }

  async enqueue(item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const priority = getPriorityScore(item.queueReason);
    const serialized: SerializedQueueItem = {
      ...item,
      priority,
      attemptCount: 0,
      itemKey,
    };

    try {
      await this.redis.zadd(PENDING_KEY, priority, JSON.stringify(serialized));
      this.logger.info(
        { owner: item.owner, repo: item.repo, issue: item.issueNumber, priority },
        'Item enqueued to Redis sorted set'
      );
    } catch (error) {
      this.logger.warn(
        { err: error, itemKey },
        'Redis error in enqueue, item not added to queue'
      );
    }
  }

  async claim(workerId: string): Promise<QueueItem | null> {
    this.ensureClaimCommand();

    const pendingKey = PENDING_KEY;
    const claimedKey = buildClaimedKey(workerId);
    const heartbeatKey = buildHeartbeatKey(workerId);
    const ttlSeconds = Math.ceil(30000 / 1000); // Default; actual TTL managed by dispatcher's heartbeat refresh

    try {
      const result = await (this.redis as any).claimItem(
        pendingKey,
        claimedKey,
        heartbeatKey,
        ttlSeconds
      );

      if (!result) {
        return null;
      }

      const serialized: SerializedQueueItem = JSON.parse(result as string);
      this.logger.info(
        { workerId, itemKey: serialized.itemKey, attempt: serialized.attemptCount },
        'Item claimed from queue'
      );

      return {
        owner: serialized.owner,
        repo: serialized.repo,
        issueNumber: serialized.issueNumber,
        workflowName: serialized.workflowName,
        command: serialized.command,
        priority: serialized.priority,
        enqueuedAt: serialized.enqueuedAt,
        metadata: serialized.metadata,
        queueReason: serialized.queueReason,
      };
    } catch (error) {
      this.logger.warn(
        { err: error, workerId },
        'Redis error in claim, returning null'
      );
      return null;
    }
  }

  async release(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const claimedKey = buildClaimedKey(workerId);
    const heartbeatKey = buildHeartbeatKey(workerId);

    try {
      // Get the claimed item to check attempt count
      const claimedRaw = await this.redis.hget(claimedKey, itemKey);
      let attemptCount = 0;
      if (claimedRaw) {
        const parsed: SerializedQueueItem = JSON.parse(claimedRaw);
        attemptCount = parsed.attemptCount + 1;
      }

      if (attemptCount >= this.maxRetries) {
        // Dead-letter: too many retries. Co-atomically remove from in-flight SET.
        const deadLetterItem: SerializedQueueItem = {
          ...item,
          attemptCount,
          itemKey,
        };
        await this.redis
          .multi()
          .hdel(claimedKey, itemKey)
          .del(heartbeatKey)
          .zadd(DEAD_LETTER_KEY, Date.now(), JSON.stringify(deadLetterItem))
          .srem(IN_FLIGHT_KEY, itemKey)
          .exec();
        this.logger.warn(
          { workerId, itemKey, attemptCount, maxRetries: this.maxRetries },
          'Item dead-lettered after max retries'
        );
      } else {
        // Re-queue with retry priority. Item stays in in-flight SET (still in flight).
        const retryPriority = getPriorityScore('retry');
        const requeueItem: SerializedQueueItem = {
          ...item,
          queueReason: 'retry',
          priority: retryPriority,
          attemptCount,
          itemKey,
        };
        await this.redis
          .multi()
          .hdel(claimedKey, itemKey)
          .del(heartbeatKey)
          .zadd(PENDING_KEY, retryPriority, JSON.stringify(requeueItem))
          .exec();
        this.logger.info(
          { workerId, itemKey, attemptCount },
          'Item released back to pending queue'
        );
      }
    } catch (error) {
      this.logger.warn(
        { err: error, workerId, itemKey },
        'Redis error in release'
      );
    }
  }

  async complete(workerId: string, item: QueueItem): Promise<void> {
    const itemKey = buildItemKey(item);
    const claimedKey = buildClaimedKey(workerId);
    const heartbeatKey = buildHeartbeatKey(workerId);

    try {
      await this.redis
        .multi()
        .hdel(claimedKey, itemKey)
        .del(heartbeatKey)
        .srem(IN_FLIGHT_KEY, itemKey)
        .exec();
      this.logger.info(
        { workerId, itemKey },
        'Item completed and removed from claimed set + in-flight index'
      );
    } catch (error) {
      this.logger.warn(
        { err: error, workerId, itemKey },
        'Redis error in complete'
      );
    }
  }

  async getQueueDepth(): Promise<number> {
    try {
      return await this.redis.zcard(PENDING_KEY);
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getQueueDepth');
      return 0;
    }
  }

  async getQueueItems(offset: number, limit: number): Promise<QueueItemWithScore[]> {
    try {
      const results = await this.redis.zrange(
        PENDING_KEY,
        offset,
        offset + limit - 1,
        'WITHSCORES'
      );

      const items: QueueItemWithScore[] = [];
      // Results come as [member, score, member, score, ...]
      for (let i = 0; i + 1 < results.length; i += 2) {
        const member = results[i];
        const scoreStr = results[i + 1];
        if (!member || !scoreStr) continue;
        const serialized: SerializedQueueItem = JSON.parse(member);
        const score = parseFloat(scoreStr);
        items.push({
          item: {
            owner: serialized.owner,
            repo: serialized.repo,
            issueNumber: serialized.issueNumber,
            workflowName: serialized.workflowName,
            command: serialized.command,
            priority: serialized.priority,
            enqueuedAt: serialized.enqueuedAt,
            metadata: serialized.metadata,
            queueReason: serialized.queueReason,
          },
          score,
        });
      }

      return items;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getQueueItems');
      return [];
    }
  }

  async getActiveWorkerCount(): Promise<number> {
    try {
      // Scan for all claimed hash keys and sum their lengths
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, matchedKeys] = await this.redis.scan(
          cursor,
          'MATCH',
          `${CLAIMED_KEY_PREFIX}*`,
          'COUNT',
          100
        );
        cursor = nextCursor;
        keys.push(...matchedKeys);
      } while (cursor !== '0');

      let count = 0;
      for (const key of keys) {
        count += await this.redis.hlen(key);
      }
      return count;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis error in getActiveWorkerCount');
      return 0;
    }
  }
}
