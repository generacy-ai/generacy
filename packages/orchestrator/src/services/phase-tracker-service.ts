import type { Redis } from 'ioredis';
import type { PhaseTracker } from '../types/index.js';

const DEFAULT_TTL_SECONDS = 86400; // 24 hours

interface Logger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PhaseTrackerOptions {
  /** TTL for dedup keys in seconds (default: 86400 = 24h) */
  ttlSeconds?: number;
}

/**
 * Redis-backed phase tracker for deduplication.
 * Uses SET with TTL to prevent duplicate processing of the same issue+phase.
 * Gracefully degrades when Redis is unavailable (treats as "not duplicate").
 */
export class PhaseTrackerService implements PhaseTracker {
  private readonly redis: Redis | null;
  private readonly logger: Logger;
  private readonly ttlSeconds: number;

  constructor(logger: Logger, redis: Redis | null, options?: PhaseTrackerOptions) {
    this.logger = logger;
    this.redis = redis;
    this.ttlSeconds = options?.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private buildKey(owner: string, repo: string, issue: number, phase: string): string {
    return `phase-tracker:${owner}:${repo}:${issue}:${phase}`;
  }

  async isDuplicate(owner: string, repo: string, issue: number, phase: string): Promise<boolean> {
    if (!this.redis) {
      this.logger.warn('Redis unavailable for phase tracker, treating as not duplicate');
      return false;
    }

    const key = this.buildKey(owner, repo, issue, phase);

    try {
      const exists = await this.redis.exists(key);
      if (exists) {
        this.logger.info({ key, owner, repo, issue, phase }, 'Duplicate event detected');
      }
      return exists === 1;
    } catch (error) {
      this.logger.warn(
        { err: error, key },
        'Redis error in isDuplicate, treating as not duplicate'
      );
      return false;
    }
  }

  async clear(owner: string, repo: string, issue: number, phase: string): Promise<void> {
    if (!this.redis) {
      return;
    }

    const key = this.buildKey(owner, repo, issue, phase);

    try {
      await this.redis.del(key);
      this.logger.info({ key }, 'Cleared dedup key');
    } catch (error) {
      this.logger.warn(
        { err: error, key },
        'Redis error in clear, deduplication may block this event'
      );
    }
  }

  async markProcessed(owner: string, repo: string, issue: number, phase: string): Promise<void> {
    if (!this.redis) {
      this.logger.warn('Redis unavailable for phase tracker, skipping markProcessed');
      return;
    }

    const key = this.buildKey(owner, repo, issue, phase);

    try {
      await this.redis.set(key, '1', 'EX', this.ttlSeconds);
      this.logger.info({ key, ttl: this.ttlSeconds }, 'Marked phase as processed');
    } catch (error) {
      this.logger.warn(
        { err: error, key },
        'Redis error in markProcessed, deduplication may not work for this event'
      );
    }
  }
}
